"""Exercise the Docker MFEM flag gate with fake tools; never compile native code."""
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]


def run_instructions():
    commands = []
    current = []
    for line in (ROOT / "docker/fem-gpu/Dockerfile").read_text().splitlines():
        if not current and not line.startswith("RUN "):
            continue
        current.append(line[4:] if not current else line)
        if not line.endswith("\\"):
            commands.append("\n".join(current).replace("\\\n", " "))
            current = []
    return commands


class MfemCudaFastCompileTests(unittest.TestCase):
    def configure(self, level, *, supported=True, help_fails=False):
        command = next(value for value in run_instructions()
                       if "cmake -S /tmp/build/mfem -B /tmp/build/mfem/build " in value)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cmake = root / "cmake"
            cmake.write_text(f"#!{sys.executable}\nimport json,os,sys\n"
                             "with open(os.environ['CMAKE_LOG'], 'a') as stream:\n"
                             " stream.write(json.dumps(sys.argv[1:])+'\\n')\n")
            cmake.chmod(0o755)
            nvcc = root / "nvcc"
            nvcc.write_text("#!/bin/sh\nprintf '%s\\n' invoked >> \"$NVCC_LOG\"\n"
                            + ("exit 1\n" if help_fails else
                               "printf '%s\\n' '" + ("--Ofast-compile" if supported else "CUDA 12.4 options") + "'\n"))
            nvcc.chmod(0o755)
            environment = {**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "CMAKE_LOG": str(root / "cmake.jsonl"), "NVCC_LOG": str(root / "nvcc.log"),
                "FULLMAG_MFEM_CUDA_FAST_COMPILE": level, "FULLMAG_MFEM_BUILD_JOBS": "1",
                "FULLMAG_CUDA_ARCHITECTURES": "120-real;120-virtual", "INSTALL_PREFIX": "/synthetic/deps"}
            result = subprocess.run(["bash", "-o", "pipefail", "-c", command], env=environment,
                                    text=True, capture_output=True, timeout=10)
            calls = [json.loads(line) for line in (root / "cmake.jsonl").read_text().splitlines()] if (root / "cmake.jsonl").exists() else []
            probed = (root / "nvcc.log").exists()
        return result, calls, probed

    def test_zero_keeps_older_toolchain_without_capability_probe_or_new_flags(self):
        result, calls, probed = self.configure("0", supported=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(probed)
        self.assertEqual(len(calls), 3)
        self.assertFalse(any("--Ofast-compile" in item for call in calls for item in call))

    def test_explicit_levels_reach_gpu_cmake_without_changing_architectures(self):
        for level in ("min", "mid", "max"):
            with self.subTest(level=level):
                result, calls, probed = self.configure(level)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(probed)
                self.assertIn("-DCMAKE_CUDA_FLAGS=--Ofast-compile=" + level, calls[0])
                self.assertIn("-DCMAKE_CUDA_ARCHITECTURES=120-real;120-virtual", calls[0])
                self.assertIn("-DMFEM_USE_CUDA=YES", calls[0])
                self.assertIn("-DMFEM_ENABLE_TESTING=OFF", calls[0])

    def test_unsupported_nvcc_and_failed_help_refuse_before_cmake(self):
        for options in ({"supported": False}, {"help_fails": True}):
            with self.subTest(options=options):
                result, calls, _ = self.configure("mid", **options)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_invalid_levels_refuse_before_tools(self):
        for level in ("", "off", "MID", "mid;exit 0"):
            with self.subTest(level=level):
                result, calls, probed = self.configure(level)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])
                self.assertFalse(probed)

    def test_manifest_postlude_is_preserved_by_actual_runtime_augmentation(self):
        command = next(value for value in run_instructions() if "--phase deps" in value)
        postlude = shlex.split(command.split(" && ", 1)[1])
        self.assertEqual(postlude[:2], ["python3", "-c"])
        spec = importlib.util.spec_from_file_location("mfem_manifest_writer_test", ROOT / "docker/fem-gpu/write_dependency_versions.py")
        writer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(writer)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "manifest.json"
            manifest = {"schema": writer.SCHEMA, "declared": {"mfem": {"retained": True}},
                        "actual": {"source_commits": {"mfem": "a" * 40}}, "build": {"phase": "deps"}}
            output.write_text(json.dumps(manifest))
            subprocess.run([sys.executable, "-c", postlude[2], str(output)], check=True,
                           env={**os.environ, "FULLMAG_MFEM_CUDA_FAST_COMPILE": "mid"})
            augmented = json.loads(output.read_text())
            self.assertEqual(augmented["declared"]["mfem"], {"retained": True, "cuda_fast_compile": "mid"})
            self.assertEqual(augmented["actual"], manifest["actual"])
            with mock.patch.object(writer, "_parse", return_value=type("Args", (), {"phase": "runtime", "output": output})()), \
                    mock.patch.object(writer, "_tool_versions", return_value={}), \
                    mock.patch.object(writer, "_base_image", return_value={"reference": "synthetic", "digest": None}):
                self.assertEqual(writer.main(), 0)
            runtime = json.loads(output.read_text())
            self.assertEqual(runtime["schema"], manifest["schema"])
            self.assertEqual(runtime["actual"]["source_commits"], manifest["actual"]["source_commits"])
            self.assertEqual(runtime["declared"]["mfem"], augmented["declared"]["mfem"])


if __name__ == "__main__":
    unittest.main()
