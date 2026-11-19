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


class DevCudaTargetTests(unittest.TestCase):
    def probe(self, output, *, executable="nvidia-smi", linux=False):
        with patch.object(control.shutil, "which", return_value=executable), \
                patch.object(control.sys, "platform", "linux" if linux else "win32"), \
                patch.object(Path, "is_file", return_value=linux), \
                patch.object(control.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 0, output, "")) as run:
            return control._host_cuda_targets(), run

    def test_queries_windows_and_wsl_for_one_real_target(self):
        for executable, linux, expected in (
            ("nvidia-smi.exe", False, "nvidia-smi.exe"),
            (None, True, "/usr/lib/wsl/lib/nvidia-smi"),
        ):
            with self.subTest(linux=linux):
                values, run = self.probe("8.6\n8.6\n", executable=executable, linux=linux)
                self.assertEqual(values, {"86-real"})
                self.assertEqual(run.call_args.args[0], [
                    expected, "--query-gpu=compute_cap", "--format=csv,noheader",
                ])

    def test_normalizes_h100_compute_capability(self):
        targets, _ = self.probe("9.0\n")
        with patch.object(control, "_host_cuda_targets", return_value=targets):
            self.assertEqual(control._selected_dev_cuda_target({}), "90-real")

    def test_unknown_probe_does_not_guess_and_confirmed_target_is_accepted(self):
        for output in ("", "8.6\n[N/A]\n"):
            targets, _ = self.probe(output)
            self.assertEqual(targets, set())
        with patch.object(control, "_host_cuda_targets", return_value=targets):
            with self.assertRaisesRegex(control.BuildControlError, "FULLMAG_DEV_CUDA_ARCHITECTURES"):
                control._selected_dev_cuda_target({})
            self.assertEqual(control._selected_dev_cuda_target({
                "FULLMAG_DEV_CUDA_ARCHITECTURES": "86-real",
            }), "86-real")

    def test_mismatched_and_multiple_host_capabilities_are_rejected(self):
        selector = "FULLMAG_DEV_CUDA_ARCHITECTURES"
        for capabilities, options in (
            ({"86-real", "89-real"}, {}), ({"86-real", "89-real"}, {selector: "86-real"}),
            ({"86-real"}, {selector: "89-real"}), ({"86-real"}, {selector: "all"}),
            ({"86-real"}, {selector: "86-virtual"}), ({"86-real"}, {selector: "86-real;89-real"}),
        ):
            with self.subTest(capabilities=capabilities, options=options), \
                    patch.object(control, "_host_cuda_targets", return_value=capabilities):
                with self.assertRaises(control.BuildControlError):
                    control._selected_dev_cuda_target(options)

    def test_receipt_target_is_recovered_without_host_probe(self):
        args = {
            "FULLMAG_CUDA_ARCHITECTURES": "86-real",
            "FULLMAG_HYPRE_GPU_ARCHITECTURES": "86",
            "FULLMAG_PETSC_CUDA_ARCHITECTURES": "86",
            "FULLMAG_LIBCEED_CUDA_ARCHITECTURE": "86",
        }
        with patch.object(control, "_host_cuda_targets", side_effect=AssertionError("recovery probed GPU")):
            self.assertEqual(control.receipt_dev_cuda_target({"inputs": {"build_args": args}}), "86-real")
            with self.assertRaisesRegex(control.BuildControlError, "PETSC"):
                control.receipt_dev_cuda_target({"inputs": {"build_args": {
                    **args, "FULLMAG_PETSC_CUDA_ARCHITECTURES": "89",
                }}})
            self.assertIsNone(control.receipt_dev_cuda_target({"inputs": {"build_args": {
                **args, "FULLMAG_CUDA_ARCHITECTURES": "80-real;89-real",
                "FULLMAG_LIBCEED_CUDA_ARCHITECTURE": "",
            }}}))


class LibceedCudaTargetTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "GNU Bash dependency-stage shell")
    def test_release_keeps_make_defaults_and_dev_passes_one_real_target(self):
        dockerfile = Path(__file__).resolve().parents[1] / "docker/fem-gpu/Dockerfile"
        recipe = dockerfile.read_text(encoding="utf-8").split("RUN ceed_cuda_", 1)[1].split(
            "\n\n", 1,
        )[0]
        command = "make() { printf '%s\\n' \"$@\"; }; ceed_cuda_" + recipe
        for capability, expected in (
            ("", []),
            ("86", ["CUDA_ARCH=compute_86 --gpu-code=sm_86"] * 2),
        ):
            with self.subTest(capability=capability):
                run = subprocess.run(
                    ["bash", "-c", command], text=True, capture_output=True, timeout=20,
                    env={**os.environ, "FULLMAG_LIBCEED_CUDA_ARCHITECTURE": capability},
                )
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(
                    [line for line in run.stdout.splitlines() if line.startswith("CUDA_ARCH=")],
                    expected,
                )


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

    def test_direct_compose_keeps_the_project_and_all_selected_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            main = Path(directory)
            shutil.copyfile(self.compose, main / "compose.toolchain.yaml")
            values = {
                "FULLMAG_CUDA_ARCHITECTURES": "86-real",
                "FULLMAG_HYPRE_GPU_ARCHITECTURES": "86",
                "FULLMAG_PETSC_CUDA_ARCHITECTURES": "86",
                "FULLMAG_LIBCEED_CUDA_ARCHITECTURE": "86",
            }
            with patch.object(bootstrap.storage, "worktree_records", return_value=[
                {"worktree": str(main)},
            ]), patch.object(control, "_host_cuda_targets", return_value={"86-real"}):
                document = control.toolchain_configuration(
                    main, {"project_name": "fullmag-worktree-input-test"}, direct_dev=True,
                )
            self.assertEqual(document["name"], "fullmag-worktree-input-test")
            args = document["services"]["fem-gpu-toolchain"]["build"]["args"]
            self.assertEqual({key: args[key] for key in values}, values)

    def test_default_mfem_concurrency_and_cuda_architectures(self):
        args = self.configuration({})
        self.assertEqual(args["FULLMAG_MFEM_BUILD_JOBS"], "1")
        self.assertEqual(args["FULLMAG_CPU_DEPENDENCY_BUILD_JOBS"], "2")
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
            "FULLMAG_CPU_DEPENDENCY_BUILD_JOBS": "16",
            "FULLMAG_HYPRE_MEMORY_VARIANT": "cuda_async",
            "FULLMAG_CUDA_BASE_IMAGE": "example/cuda@sha256:" + "a" * 64,
            "FULLMAG_CUDA_BASE_IMAGE_DIGEST": "a" * 64,
        }
        args = self.configuration(selected)
        self.assertEqual({key: args[key] for key in selected}, selected)


if __name__ == "__main__":
    unittest.main()
