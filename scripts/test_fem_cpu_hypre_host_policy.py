"""Source contract: the native FEM CPU lane binds HYPRE to the host.

The production stack links one CUDA-enabled HYPRE for both FEM lanes, and its
process default allocates HYPRE memory on the device. Accepted CPU workers
run with CUDA_VISIBLE_DEVICES="" (accepted_study_supervisor.rs), so a CPU
context that left the default aborted in hypre_MAlloc_core with
"CUDA ERROR (code = 100)" and MPI_ABORT errorcode -1 at the first solve, and
with a visible GPU it silently ran the CPU lane's AMG on the device.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "backends" / "fem" / "cpu" / "mfem" / "runtime"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _body(source: str, signature: str) -> str:
    start = source.index(signature)
    depth = 0
    for index in range(source.index("{", start), len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated body for {signature}")


class FemCpuHypreHostPolicyContract(unittest.TestCase):
    def test_policy_binds_host_memory_and_execution_only(self):
        source = _read(RUNTIME / "hypre_host_policy.cpp")
        body = _body(source, "bool configure_hypre_host_policy(std::string &error)")
        self.assertIn("HYPRE_Initialized()", body)
        self.assertIn("HYPRE_SetMemoryLocation(HYPRE_MEMORY_HOST)", body)
        self.assertIn("HYPRE_SetExecutionPolicy(HYPRE_EXEC_HOST)", body)
        self.assertNotIn("HYPRE_MEMORY_DEVICE", body)
        self.assertNotIn("HYPRE_EXEC_DEVICE", body)
        self.assertNotRegex(source, r"\bcuda[A-Z]\w*\(")

    def test_cpu_context_binds_policy_before_any_mfem_or_hypre_object(self):
        source = _read(RUNTIME / "mfem_context.cpp")
        body = _body(source, "bool context_initialize_mfem(Context &ctx, std::string &error)")
        bind = body.index("configure_hypre_host_policy(error)")
        self.assertRegex(
            body[:bind + 64],
            r"!mfem_device_requests_gpu\(ctx\)\s*&&\s*!configure_hypre_host_policy\(error\)",
        )
        for later in ("new mfem::Device(", "log_cpu_runtime_selection(ctx)",
                      "mfem::FiniteElementSpace>(", "context_initialize_mfem:device_ready"):
            self.assertLess(bind, body.index(later), later)

    def test_cpu_runtime_banner_reports_resolved_hypre_policy(self):
        source = _read(RUNTIME / "cpu_threads.cpp")
        body = _body(source, "void log_cpu_runtime_selection(const Context &ctx)")
        self.assertIn("current_hypre_host_policy()", body)
        self.assertTrue(re.search(r"hypre_memory=%s hypre_execution=%s hypre_policy_owner=%s", body))

    def test_policy_source_is_part_of_the_native_library(self):
        cmake = _read(ROOT / "backends" / "fem" / "CMakeLists.txt")
        self.assertIn("cpu/mfem/runtime/hypre_host_policy.cpp", cmake)

    def test_cpu_workers_still_hide_gpus(self):
        supervisor = _read(ROOT / "crates" / "fullmag-api" / "src" / "accepted_study_supervisor.rs")
        self.assertIn('("CUDA_VISIBLE_DEVICES", Some(String::new()))', supervisor)


if __name__ == "__main__":
    unittest.main()
