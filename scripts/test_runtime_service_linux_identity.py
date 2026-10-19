"""Packaged guest runtime must admit Linux without the host launcher helper."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_SERVICE = REPO_ROOT / "docker" / "all-in-one" / "runtime_service.py"


def _load_runtime_without_host_helper(path: Path):
    spec = importlib.util.spec_from_file_location("packaged_runtime_service_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load packaged runtime service from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class PackagedLinuxRuntimeIdentityTests(unittest.TestCase):
    def test_linux_admission_needs_only_the_shipped_runtime_module(self):
        with tempfile.TemporaryDirectory() as directory:
            packaged_runtime = Path(directory) / "runtime_service.py"
            packaged_runtime.write_bytes(RUNTIME_SERVICE.read_bytes())

            with patch.dict(sys.modules, {"linux_docker_host": None}):
                module = _load_runtime_without_host_helper(packaged_runtime)
                with patch.object(sys, "platform", "linux"), \
                    patch.object(module.os, "getuid", return_value=123456, create=True), \
                    patch.object(module.os, "getgid", return_value=234567, create=True):
                    environment = {
                        "FULLMAG_SESSION_STORAGE_PROFILE": "linux-native-v1",
                        "FULLMAG_RUNTIME_UID": "123456",
                        "FULLMAG_RUNTIME_GID": "234567",
                    }
                    self.assertEqual(
                        module.storage_profile(environment), "linux-native-v1"
                    )
                    self.assertEqual(
                        module._runtime_identity(environment), (123456, 234567)
                    )

                    environment["FULLMAG_RUNTIME_GID"] = "234568"
                    with self.assertRaisesRegex(
                        ValueError, "FULLMAG_RUNTIME_GID must equal the current"
                    ):
                        module._runtime_identity(environment)

    def test_linux_identity_rejects_root_and_out_of_range_ids(self):
        module = _load_runtime_without_host_helper(RUNTIME_SERVICE)
        with patch.object(sys, "platform", "linux"), \
                patch.object(module.os, "getuid", return_value=0, create=True), \
                patch.object(module.os, "getgid", return_value=1000, create=True):
            with self.assertRaisesRegex(ValueError, "non-root caller"):
                module._runtime_identity({})

        with patch.object(module.sys, "platform", "linux"), \
                patch.object(module.os, "getuid", return_value=2**31, create=True), \
                patch.object(module.os, "getgid", return_value=1000, create=True):
            with self.assertRaisesRegex(ValueError, "exceed the supported range"):
                module._runtime_identity({})


if __name__ == "__main__":
    unittest.main()
