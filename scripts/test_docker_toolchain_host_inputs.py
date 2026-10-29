"""Exercise Compose dotenv interpolation without a daemon or image build."""
from pathlib import Path
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import bootstrap_docker_toolchain as bootstrap
import docker_build_control as control

from docker_dev_host import docker_argv


class ToolchainHostInputsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if shutil.which("docker") is None:
            raise unittest.SkipTest("Docker CLI is unavailable")
        try:
            version = subprocess.run(docker_argv("compose", "version", "--short"),
                                     text=True, capture_output=True, timeout=20)
        except (FileNotFoundError, subprocess.TimeoutExpired) as error:
            raise unittest.SkipTest(f"Docker Compose parser is unavailable: {error}") from error
        if version.returncode:
            raise unittest.SkipTest("Docker Compose parser is unavailable: " + version.stderr.strip())
        cls.compose = Path(__file__).resolve().parents[1] / "compose.toolchain.yaml"
        # Clear only inputs interpolated by this recipe. Preserve DOCKER_HOST,
        # DOCKER_CONTEXT and other endpoint settings selected by the operator.
        cls.inputs = set(re.findall(r"\$\{(FULLMAG_[A-Z0-9_]+)", cls.compose.read_text()))

    def configuration(self, overrides):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            values = {
                "FULLMAG_COMPOSE_PROJECT": "fullmag-toolchain-input-test",
                "FULLMAG_TOOLCHAIN_IMAGE": "fullmag/toolchain-input-test:local",
                "FULLMAG_TOOLCHAIN_CONTEXT": str(fixture),
                "FULLMAG_BUILD_CONTROL_VOLUME": "fullmag-toolchain-input-test-control",
                "FULLMAG_PROJECT_STORAGE_ROOT": str(fixture / "synthetic-storage"),
                **overrides,
            }
            (fixture / ".env").write_text("".join(f"{key}={value}\n" for key, value in values.items()))
            environment = {key: value for key, value in os.environ.items() if key not in self.inputs}
            configured = subprocess.run(
                docker_argv("compose", "--project-directory", str(fixture),
                            "-f", str(self.compose), "--profile", "toolchain",
                            "config", "--format", "json"),
                cwd=fixture, env=environment, text=True, capture_output=True, timeout=30)
            self.assertEqual(configured.returncode, 0, configured.stderr)
            return json.loads(configured.stdout)["services"]["fem-gpu-toolchain"]["build"]["args"]

    def test_main_dotenv_reaches_worktree_bootstrap_and_control_rendering(self):
        with tempfile.TemporaryDirectory() as directory:
            main = Path(directory) / "main"
            worktree = Path(directory) / "worktrees" / "task"
            main.mkdir()
            worktree.mkdir(parents=True)
            shutil.copyfile(self.compose, worktree / "compose.toolchain.yaml")
            selected = {
                "FULLMAG_CUDA_ARCHITECTURES": "86-real;86-virtual",
                "FULLMAG_HYPRE_GPU_ARCHITECTURES": "86",
                "FULLMAG_PETSC_CUDA_ARCHITECTURES": "86",
                "FULLMAG_MFEM_BUILD_JOBS": "2",
                "FULLMAG_MFEM_CUDA_FAST_COMPILE": "0",
            }
            (main / ".env").write_text(
                "".join(f"{key}={value}\n" for key, value in selected.items())
                + "UNRELATED_SECRET=private\n")
            (worktree / ".env").write_text("FULLMAG_MFEM_BUILD_JOBS=99\n")
            environment = {key: value for key, value in os.environ.items() if key not in self.inputs}
            environment["FULLMAG_MFEM_BUILD_JOBS"] = "4"
            selected["FULLMAG_MFEM_BUILD_JOBS"] = "4"
            with patch.dict(os.environ, environment, clear=True), \
                    patch.object(bootstrap.storage, "worktree_records", return_value=[
                        {"worktree": str(main)}, {"worktree": str(worktree)}]):
                resolved = bootstrap._compose_environment(worktree, "fullmag-worktree-input-test")
                self.assertNotIn("UNRELATED_SECRET", resolved)
                configured = control.toolchain_configuration(
                    worktree, {"project_name": "fullmag-worktree-input-test"})
            args = configured["services"]["fem-gpu-toolchain"]["build"]["args"]
            self.assertEqual({key: resolved[key] for key in selected}, selected)
            self.assertEqual({key: args[key] for key in selected}, selected)

    def test_default_mfem_concurrency_and_cuda_architectures(self):
        args = self.configuration({})
        self.assertEqual(args["FULLMAG_MFEM_BUILD_JOBS"], "1")
        self.assertEqual(args["FULLMAG_MFEM_CUDA_FAST_COMPILE"], "0")
        self.assertEqual(args["FULLMAG_CUDA_ARCHITECTURES"], "80-real;89-real;90-real;90-virtual")
        self.assertEqual(args["FULLMAG_PETSC_CUDA_ARCHITECTURES"], "80,89,90")

    def test_dotenv_passes_selected_gpu_targets_and_jobs_to_builder(self):
        selected = {
            "FULLMAG_CUDA_ARCHITECTURES": "120-real;120-virtual",
            "FULLMAG_HYPRE_GPU_ARCHITECTURES": "120",
            "FULLMAG_PETSC_CUDA_ARCHITECTURES": "120",
            "FULLMAG_MFEM_BUILD_JOBS": "2",
            "FULLMAG_MFEM_CUDA_FAST_COMPILE": "mid",
            "FULLMAG_HYPRE_MEMORY_VARIANT": "cuda_async",
            "FULLMAG_CUDA_BASE_IMAGE": "example/cuda@sha256:" + "a" * 64,
            "FULLMAG_CUDA_BASE_IMAGE_DIGEST": "a" * 64,
        }
        args = self.configuration(selected)
        self.assertEqual({key: args[key] for key in selected}, selected)


if __name__ == "__main__":
    unittest.main()
