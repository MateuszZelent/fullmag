"""DEV toolchain CUDA target selection without a daemon, GPU or image build."""
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import docker_build_control as control


def _smi(stdout, returncode=0):
    return subprocess.CompletedProcess([], returncode, stdout, "")


class ToolchainCudaArchitectureTests(unittest.TestCase):
    def setUp(self):
        control._HOST_CUDA_CAPABILITIES.clear()
        self.addCleanup(control._HOST_CUDA_CAPABILITIES.clear)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.repo = Path(directory.name)

    def select(self, environ=None, *, smi=None, executable="/usr/bin/nvidia-smi"):
        with mock.patch.object(control.shutil, "which", return_value=executable), \
             mock.patch.object(control.os.path, "isfile", return_value=False), \
             mock.patch.object(control.subprocess, "run", side_effect=smi or [_smi("8.9\n")]) as run:
            selected = control.toolchain_cuda_environment(self.repo, environ or {})
        return selected, run

    def test_detected_gpu_narrows_all_dependency_targets(self):
        selected, run = self.select()
        self.assertEqual(selected, {
            "FULLMAG_CUDA_ARCHITECTURES": "89-real",
            "FULLMAG_HYPRE_GPU_ARCHITECTURES": "89",
            "FULLMAG_PETSC_CUDA_ARCHITECTURES": "89",
        })
        self.assertEqual(run.call_args.args[0][1:], ["--query-gpu=compute_cap", "--format=csv,noheader"])

    def test_multiple_gpus_select_their_sorted_union(self):
        selected, _ = self.select(smi=[_smi("12.0\n8.9\n8.9\n")])
        self.assertEqual(selected["FULLMAG_CUDA_ARCHITECTURES"], "89-real;120-real")
        self.assertEqual(selected["FULLMAG_HYPRE_GPU_ARCHITECTURES"], "89 120")
        self.assertEqual(selected["FULLMAG_PETSC_CUDA_ARCHITECTURES"], "89,120")

    def test_probe_is_memoized_for_identical_identity_checks(self):
        with mock.patch.object(control.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             mock.patch.object(control.subprocess, "run", return_value=_smi("8.9\n")) as run:
            first = control.toolchain_cuda_environment(self.repo, {})
            second = control.toolchain_cuda_environment(self.repo, {})
        self.assertEqual(first, second)
        self.assertEqual(run.call_count, 1)

    def test_host_without_driver_keeps_image_matrix(self):
        selected, run = self.select(executable=None)
        self.assertEqual(selected, {})
        run.assert_not_called()

    def test_wsl_driver_path_is_used_when_not_on_path(self):
        with mock.patch.object(control.shutil, "which", return_value=None), \
             mock.patch.object(control.os.path, "isfile", return_value=True), \
             mock.patch.object(control.subprocess, "run", return_value=_smi("8.9\n")) as run:
            control.toolchain_cuda_environment(self.repo, {})
        self.assertEqual(run.call_args.args[0][0], "/usr/lib/wsl/lib/nvidia-smi")

    def test_transient_probe_failure_is_retried(self):
        selected, run = self.select(smi=[subprocess.TimeoutExpired("nvidia-smi", 20), _smi("8.9\n")])
        self.assertEqual(selected["FULLMAG_CUDA_ARCHITECTURES"], "89-real")
        self.assertEqual(run.call_count, 2)

    def test_unreadable_driver_fails_instead_of_switching_matrix(self):
        with self.assertRaisesRegex(control.BuildControlError, "FULLMAG_DEV_CUDA_ARCHITECTURES=all"):
            self.select(smi=[_smi("", 9), _smi("[N/A]\n"), OSError("busy")])

    def test_unreadable_driver_is_not_probed_again_in_one_run(self):
        with self.assertRaises(control.BuildControlError):
            self.select(smi=[_smi("", 9)] * 3)
        with self.assertRaises(control.BuildControlError):
            self.select(smi=AssertionError("probed twice"))

    def test_observation_configuration_tolerates_unreadable_driver(self):
        failure = control.BuildControlError("nvidia-smi did not report")
        with mock.patch.object(control, "toolchain_cuda_environment", side_effect=failure), \
             mock.patch.object(control, "docker_capture",
                               return_value=subprocess.CompletedProcess([], 0, b"{}", b"")) as capture, \
             mock.patch.dict(control.os.environ, {}, clear=False):
            control.os.environ.pop("FULLMAG_CUDA_ARCHITECTURES", None)
            control.toolchain_configuration(self.repo.resolve(), {"project_name": "fullmag-master"})
            self.assertNotIn("FULLMAG_CUDA_ARCHITECTURES", capture.call_args.kwargs["env"])
            with self.assertRaisesRegex(control.BuildControlError, "nvidia-smi"):
                control.toolchain_configuration(self.repo.resolve(), {"project_name": "fullmag-master"},
                                                require_cuda_selection=True)

    def test_explicit_process_targets_are_kept_verbatim(self):
        selected, run = self.select({"FULLMAG_CUDA_ARCHITECTURES": "90-real"})
        self.assertEqual(selected, {})
        run.assert_not_called()

    def test_explicit_dotenv_targets_are_kept_verbatim(self):
        (self.repo / ".env").write_text("# local\nexport FULLMAG_PETSC_CUDA_ARCHITECTURES=80\n")
        selected, run = self.select()
        self.assertEqual(selected, {})
        run.assert_not_called()

    def test_dev_request_all_keeps_image_matrix(self):
        selected, run = self.select({"FULLMAG_DEV_CUDA_ARCHITECTURES": "all"})
        self.assertEqual(selected, {})
        run.assert_not_called()

    def test_dev_request_list_derives_dependency_targets(self):
        selected, run = self.select({"FULLMAG_DEV_CUDA_ARCHITECTURES": "89-real;90-virtual"})
        self.assertEqual(selected, {
            "FULLMAG_CUDA_ARCHITECTURES": "89-real;90-virtual",
            "FULLMAG_HYPRE_GPU_ARCHITECTURES": "89 90",
            "FULLMAG_PETSC_CUDA_ARCHITECTURES": "89,90",
        })
        run.assert_not_called()

    def test_invalid_dev_request_is_rejected(self):
        with self.assertRaisesRegex(control.BuildControlError, "auto, all, or a CMake list"):
            self.select({"FULLMAG_DEV_CUDA_ARCHITECTURES": "89;rm -rf"})

    def test_configuration_passes_selection_to_compose_interpolation(self):
        with mock.patch.object(control, "toolchain_cuda_environment",
                               return_value={"FULLMAG_CUDA_ARCHITECTURES": "89-real"}), \
             mock.patch.object(control, "docker_capture",
                               return_value=subprocess.CompletedProcess([], 0, b"{}", b"")) as capture:
            control.toolchain_configuration(self.repo.resolve(), {"project_name": "fullmag-master"})
        self.assertEqual(capture.call_args.kwargs["env"]["FULLMAG_CUDA_ARCHITECTURES"], "89-real")


if __name__ == "__main__":
    unittest.main()
