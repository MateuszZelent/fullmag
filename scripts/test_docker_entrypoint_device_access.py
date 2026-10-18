"""Source-only regression checks for the container device-access boundary."""

import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ENTRYPOINT = Path(__file__).resolve().parents[1] / "docker/all-in-one/entrypoint.py"
SPEC = importlib.util.spec_from_file_location("fullmag_docker_entrypoint", ENTRYPOINT)
entrypoint = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(entrypoint)


class DeviceAccessBoundaryTests(unittest.TestCase):
    def test_cpu_uses_only_image_compatibility_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            compat = Path(directory)
            (compat / "libcuda.so.1").write_bytes(b"image-owned-compatibility")
            with patch.object(entrypoint, "CUDA_COMPATIBILITY_ROOT", compat), \
                    patch.dict(os.environ, {
                        "FULLMAG_DOCKER_DEVICE_ACCESS": "cpu",
                        "LD_LIBRARY_PATH": "/opt/fullmag/lib:/usr/local/cuda/lib64",
                    }, clear=True):
                self.assertEqual(entrypoint._configure_device_access(), "cpu")
                self.assertEqual(
                    os.environ["LD_LIBRARY_PATH"],
                    os.pathsep.join(("/opt/fullmag/lib", "/usr/local/cuda/lib64", str(compat))),
                )
                self.assertEqual(entrypoint._configure_device_access(), "cpu")
                self.assertEqual(
                    os.environ["LD_LIBRARY_PATH"],
                    os.pathsep.join(("/opt/fullmag/lib", "/usr/local/cuda/lib64", str(compat))),
                )

    def test_cpu_preflight_keeps_storage_checks_but_skips_cuda_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            compat = Path(directory)
            (compat / "libcuda.so.1").write_bytes(b"image-owned-compatibility")
            class ProbeStream(io.BytesIO):
                def fileno(self):
                    return 7

            with patch.object(entrypoint, "CUDA_COMPATIBILITY_ROOT", compat), \
                    patch.dict(os.environ, {"FULLMAG_DOCKER_DEVICE_ACCESS": "cpu"}, clear=True), \
                    patch.object(entrypoint.subprocess, "check_output", return_value="ef53\n"), \
                    patch.object(entrypoint.ctypes, "CDLL") as cuda, \
                    patch.object(entrypoint.Path, "mkdir"), \
                    patch.object(entrypoint.Path, "open", return_value=ProbeStream()) as open_file, \
                    patch.object(entrypoint.Path, "unlink"), \
                    patch.object(entrypoint.os, "fsync"):
                entrypoint.preflight()
                cuda.assert_not_called()
                open_file.assert_called_once()

    def test_invalid_or_missing_cpu_compatibility_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(entrypoint, "CUDA_COMPATIBILITY_ROOT", Path(directory)), \
                    patch.dict(os.environ, {"FULLMAG_DOCKER_DEVICE_ACCESS": "cpu"}, clear=True):
                with self.assertRaisesRegex(RuntimeError, "compatibility library"):
                    entrypoint._configure_device_access()

    def test_invalid_device_access_value_fails_closed(self):
        with patch.dict(os.environ, {"FULLMAG_DOCKER_DEVICE_ACCESS": "maybe"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be cpu or gpu"):
                entrypoint._configure_device_access()

    def test_cpu_does_not_bypass_unsupported_storage_filesystem(self):
        with tempfile.TemporaryDirectory() as directory:
            compat = Path(directory)
            (compat / "libcuda.so.1").write_bytes(b"image-owned-compatibility")
            with patch.object(entrypoint, "CUDA_COMPATIBILITY_ROOT", compat), \
                    patch.dict(os.environ, {"FULLMAG_DOCKER_DEVICE_ACCESS": "cpu"}, clear=True), \
                    patch.object(entrypoint.subprocess, "check_output", return_value="deadbeef\n"), \
                    patch.object(entrypoint.ctypes, "CDLL") as cuda, \
                    patch.object(entrypoint.Path, "mkdir") as mkdir:
                with self.assertRaisesRegex(RuntimeError, "Unsupported durable session filesystem"):
                    entrypoint.preflight()
                cuda.assert_not_called()
                mkdir.assert_not_called()

    def test_gpu_access_keeps_existing_cuda_preflight_mode(self):
        with patch.dict(os.environ, {
            "FULLMAG_DOCKER_DEVICE_ACCESS": "gpu",
            "LD_LIBRARY_PATH": "/image/lib",
        }, clear=True):
            self.assertEqual(entrypoint._configure_device_access(), "gpu")
            self.assertEqual(os.environ["LD_LIBRARY_PATH"], "/image/lib")

    def test_legacy_environment_defaults_to_gpu(self):
        with patch.dict(os.environ, {"LD_LIBRARY_PATH": "/image/lib"}, clear=True):
            self.assertEqual(entrypoint._configure_device_access(), "gpu")
            self.assertEqual(os.environ["LD_LIBRARY_PATH"], "/image/lib")


if __name__ == "__main__":
    unittest.main()
