from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from audit_fem_cpu_only_runtime import (
    AuditInputs,
    AuditViolation,
    audit_configuration,
    audit_repository_contract,
)


GOOD_RECIPE_NAMES = (
    "verify-fem-steady-transport-cpu-only-contract",
    "verify-fem-time-domain-cpu-only-contract",
    "verify-fem-oersted-oet0-cpu-contract",
    "verify-fem-oersted-oet0-tsan-cpu-contract",
    "verify-fem-oersted-oef1-cpu-contract",
    "verify-fem-oersted-oef2-cpu-contract",
)


def good_inputs(**overrides: object) -> AuditInputs:
    values: dict[str, object] = {
        "cmake_cache": {
            "FULLMAG_ENABLE_CUDA": "OFF",
            "FULLMAG_ENABLE_FEM_GPU": "OFF",
            "FULLMAG_USE_MFEM_STACK": "ON",
        },
        "rust_features": (),
        "container_image": "fullmag/fem-cpu:local",
        "compose_profiles": (),
        "device_runtime": "cpu",
        "linked_libraries": (
            "/opt/fullmag-deps/lib/libmfem.so",
            "/opt/fullmag-deps/lib/libHYPRE.so",
            "/lib/x86_64-linux-gnu/libgomp.so.1",
        ),
    }
    values.update(overrides)
    return AuditInputs(**values)


class ConfigurationAuditTests(unittest.TestCase):
    def test_accepts_only_explicit_cpu_native_configuration(self) -> None:
        result = audit_configuration(good_inputs())

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["cmake"]["FULLMAG_ENABLE_CUDA"], "OFF")
        self.assertEqual(result["cmake"]["FULLMAG_ENABLE_FEM_GPU"], "OFF")
        self.assertEqual(result["rust_features"], [])

    def test_rejects_each_non_cpu_configuration_class(self) -> None:
        cases = {
            "CUDA enabled": good_inputs(
                cmake_cache={
                    "FULLMAG_ENABLE_CUDA": "ON",
                    "FULLMAG_ENABLE_FEM_GPU": "OFF",
                    "FULLMAG_USE_MFEM_STACK": "ON",
                }
            ),
            "FEM GPU enabled": good_inputs(
                cmake_cache={
                    "FULLMAG_ENABLE_CUDA": "OFF",
                    "FULLMAG_ENABLE_FEM_GPU": "ON",
                    "FULLMAG_USE_MFEM_STACK": "ON",
                }
            ),
            "Rust GPU feature": good_inputs(rust_features=("fem-gpu",)),
            "GPU image": good_inputs(container_image="fullmag/fem-gpu:local"),
            "GPU profile": good_inputs(compose_profiles=("fem-gpu",)),
            "device runtime": good_inputs(device_runtime="nvidia"),
            "CUDA-linked dependency": good_inputs(
                linked_libraries=(
                    "/opt/fullmag-deps/lib/libmfem.so",
                    "/usr/local/cuda/lib64/libcudart.so.12",
                )
            ),
        }

        for label, inputs in cases.items():
            with self.subTest(label=label), self.assertRaises(AuditViolation):
                audit_configuration(inputs)


class RepositoryContractTests(unittest.TestCase):
    def write_repository(self, root: Path) -> None:
        (root / "docker/fem-cpu").mkdir(parents=True)
        (root / "docs/superpowers/plans").mkdir(parents=True)
        (root / "scripts").mkdir(parents=True)
        (root / "backends/fem").mkdir(parents=True)
        (root / "docker/fem-cpu/Dockerfile").write_text(
            "FROM ubuntu:22.04\n"
            "RUN apt-get install -y --no-install-recommends libboost-dev\n"
            "RUN ./configure --without-cuda --prefix=/opt/fullmag-deps\n"
            "RUN cmake -DMFEM_USE_CUDA=NO -DMFEM_USE_HYPRE=YES .\n",
            encoding="utf-8",
        )
        (root / "compose.yaml").write_text(
            "services:\n"
            "  fem-cpu:\n"
            "    image: fullmag/fem-cpu:local\n"
            "    environment:\n"
            "      FULLMAG_MANAGED_FEM_DEVICE: cpu\n"
            "  fem-cpu-tsan:\n"
            "    extends:\n"
            "      service: fem-cpu\n"
            "    security_opt:\n"
            "      - seccomp:unconfined\n",
            encoding="utf-8",
        )
        (root / "justfile").write_text(
            "\n".join(
                f"{name}:\n"
                f"    docker compose build {'fem-cpu-tsan' if name == 'verify-fem-oersted-oet0-tsan-cpu-contract' else 'fem-cpu'}\n"
                f"    docker compose run --rm --no-deps {'fem-cpu-tsan' if name == 'verify-fem-oersted-oet0-tsan-cpu-contract' else 'fem-cpu'} "
                "./scripts/run_fem_cpu_only_contract.sh"
                f"{' oersted-oet0-tsan' if name == 'verify-fem-oersted-oet0-tsan-cpu-contract' else ''}\n"
                for name in GOOD_RECIPE_NAMES
            ),
            encoding="utf-8",
        )
        (root / "docs/superpowers/plans/2026-07-16-fem-oersted-conservative-current-direct-and-mixed.md").write_text(
            "plan with CPU-only managed verification lane\n", encoding="utf-8"
        )
        (root / "scripts/run_fem_cpu_only_contract.sh").write_text(
            "FULLMAG_OET0_DISABLE_MPI=1\n"
            "-fsanitize=thread -fno-omit-frame-pointer\n"
            "--tests-regex '^fem_conservative_current_view_contract$'\n"
            "conservative_constraint_rank.cpp\n"
            "periodic_charge_potential.cpp\n"
            "conservative_current_view.cpp\n"
            "setarch x86_64 -R ctest\n"
            "OE-T0 TSan generated instrumentation rules audit: PASS\n",
            encoding="utf-8",
        )
        (root / "backends/fem/CMakeLists.txt").write_text(
            "FULLMAG_OET0_DISABLE_MPI=1\n"
            "-fsanitize=thread -fno-omit-frame-pointer\n"
            "if(NOT FULLMAG_OET0_TSAN)\nendif()\n"
            "target_sources(fullmag_fem PRIVATE\n)\n"
            "target_sources(fem_conservative_current_view_contract PRIVATE\n)\n"
            "OE-T0 production source set is partial\n"
            "conservative_constraint_rank.cpp\n"
            "periodic_charge_potential.cpp\n"
            "conservative_current_view.cpp\n",
            encoding="utf-8",
        )

    def test_repository_contract_accepts_dedicated_cpu_service_and_recipes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_repository(root)

            result = audit_repository_contract(root)

        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["recipes"], list(GOOD_RECIPE_NAMES))

    def test_repository_contract_rejects_recipe_using_gpu_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_repository(root)
            justfile = root / "justfile"
            justfile.write_text(
                justfile.read_text(encoding="utf-8").replace(
                    "docker compose run", "docker compose --profile fem-gpu run", 1
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(AuditViolation, "GPU-backed recipe"):
                audit_repository_contract(root)

    def test_repository_contract_rejects_run_without_local_image_build(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_repository(root)
            justfile = root / "justfile"
            justfile.write_text(
                justfile.read_text(encoding="utf-8").replace(
                    "    docker compose build fem-cpu\n", "", 1
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(AuditViolation, "does not build"):
                audit_repository_contract(root)

    def test_repository_contract_rejects_gpu_enabled_dependency_build(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write_repository(root)
            dockerfile = root / "docker/fem-cpu/Dockerfile"
            dockerfile.write_text(
                dockerfile.read_text(encoding="utf-8").replace(
                    "-DMFEM_USE_CUDA=NO", "-DMFEM_USE_CUDA=YES"
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(AuditViolation, "CPU dependency build"):
                audit_repository_contract(root)

    def test_report_is_json_serializable(self) -> None:
        encoded = json.dumps(audit_configuration(good_inputs()), sort_keys=True)
        self.assertIn('"status": "pass"', encoded)

    def test_live_repository_has_complete_cpu_only_lane(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]

        result = audit_repository_contract(repository_root)

        self.assertEqual(result["recipes"], list(GOOD_RECIPE_NAMES))

    def test_ci_runs_cpu_only_repository_guard_without_building_container(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        workflow = (repository_root / ".github/workflows/bootstrap.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "python scripts/test_audit_fem_cpu_only_runtime.py -v", workflow
        )

    def test_oersted_recipes_stop_at_their_milestone_specific_targets(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        runner = (repository_root / "scripts/run_fem_cpu_only_contract.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            "oersted-oet0|oersted-oet0-tsan)\n"
            "    targets=(fem_conservative_current_view_contract)",
            runner,
        )
        self.assertIn(
            "oersted-oef1)\n    targets=(fem_conservative_current_view_contract fem_oersted_direct_tetra_contract)",
            runner,
        )
        self.assertIn(
            "oersted-oef2)\n    targets=(fem_conservative_current_view_contract fem_oersted_direct_tetra_contract fem_oersted_vector_potential_contract)",
            runner,
        )
        self.assertNotIn(
            "oersted-oet0|oersted-oef1|oersted-oef2)\n"
            "    # Task 0 proves the isolated lane only.",
            runner,
        )

    def test_oet0_tsan_lane_is_instrumented_and_serial_only(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        runner = (repository_root / "scripts/run_fem_cpu_only_contract.sh").read_text(
            encoding="utf-8"
        )
        cmake = (repository_root / "backends/fem/CMakeLists.txt").read_text(
            encoding="utf-8"
        )

        self.assertIn("-DFULLMAG_OET0_TSAN=ON", runner)
        self.assertIn("TSAN_OPTIONS=\"halt_on_error=1:exitcode=66\"", runner)
        self.assertIn("setarch x86_64 -R ctest", runner)
        self.assertIn(
            "OE-T0 TSan generated instrumentation rules audit: PASS", runner
        )
        self.assertIn("-DFULLMAG_OET0_DISABLE_MPI=1", runner)
        self.assertIn("TSan CTest registration unexpectedly contains an MPI", runner)
        self.assertIn("conservative_constraint_rank.cpp", runner)
        self.assertIn("periodic_charge_potential.cpp", runner)
        self.assertIn("conservative_current_view.cpp", runner)
        self.assertIn(
            "--tests-regex '^fem_conservative_current_view_contract$'", runner
        )
        self.assertEqual(
            runner.count('ctest --test-dir "$build_dir/backends/fem"'),
            4,
            "OE-T0 CTest discovery must run in the FEM binary directory where "
            "enable_testing() writes CTestTestfile.cmake",
        )
        self.assertIn("-fsanitize=thread -fno-omit-frame-pointer", cmake)
        self.assertIn("target_link_options(fem_conservative_current_view_contract", cmake)
        self.assertIn("FULLMAG_OET0_DISABLE_MPI=1", cmake)
        self.assertIn("if(NOT FULLMAG_OET0_TSAN)", cmake)
        self.assertIn("target_sources(fem_conservative_current_view_contract PRIVATE", cmake)
        self.assertIn("OE-T0 production source set is partial", cmake)

    def test_cpu_build_uses_macro_values_for_optional_dense_cuda_headers(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        source = (
            repository_root / "backends/fem/cpu/mfem/runtime/eigen_dense.cpp"
        ).read_text(encoding="utf-8")

        self.assertEqual(
            source.count("#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_CUSOLVER"), 2
        )
        self.assertNotIn(
            "#if defined(FULLMAG_HAS_CUDA_RUNTIME) && defined(FULLMAG_HAS_CUSOLVER)",
            source,
        )

    def test_cpu_container_uses_repository_stable_rust_toolchain(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        dockerfile = (repository_root / "docker/fem-cpu/Dockerfile").read_text(
            encoding="utf-8"
        )

        self.assertIn("--default-toolchain stable", dockerfile)
        self.assertNotIn("--default-toolchain nightly", dockerfile)

    def test_time_domain_runtime_gate_does_not_depend_on_ignored_progress_report(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        runner = (repository_root / "scripts/run_fem_cpu_only_contract.sh").read_text(
            encoding="utf-8"
        )
        rk_contract = (
            repository_root / "backends/fem/tests/rk_explicit_contract.cpp"
        ).read_text(encoding="utf-8")

        self.assertIn("fem_rk_explicit_contract", runner)
        self.assertNotIn("progress_report_marks_integrator_split_contract_covered", rk_contract)
        self.assertNotIn("fullmag_fem_cpu_refactor_progress_2026-05-16.md", rk_contract)

    def test_runtime_report_identifies_the_exact_failing_executable(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        runner = (repository_root / "scripts/run_fem_cpu_only_contract.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn(': > "$report_dir/test.log"', runner)
        self.assertIn("printf '=== %s ===\\n' \"$executable\"", runner)

    def test_disabled_or_non_strict_demag_returns_before_cuda_compile_gate(self) -> None:
        repository_root = Path(__file__).resolve().parents[1]
        source = (
            repository_root / "backends/fem/gpu/cuda/demag_poisson/poisson.cpp"
        ).read_text(encoding="utf-8")
        function = source[source.index("bool gpu_demag_poisson_initialize(") :]
        guard = (
            "if (!ctx.demag.enabled || ctx.poisson_demag.gpu_demag_mode != "
            "FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON)"
        )

        self.assertLess(
            function.index(guard),
            function.index(
                "#if FULLMAG_HAS_CUDA_RUNTIME && FULLMAG_HAS_MFEM_STACK && defined(MFEM_USE_MPI)"
            ),
        )
        self.assertEqual(function.count(guard), 1)


if __name__ == "__main__":
    unittest.main()
