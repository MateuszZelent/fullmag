from __future__ import annotations

import csv
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BENCHMARK_PATH = ROOT / "scripts" / "analysis" / "fem_gpu_benchmark.py"
NSIGHT_PATH = ROOT / "scripts" / "analysis" / "capture_fem_gpu_nsight.py"

if "resource" not in sys.modules:
    try:
        __import__("resource")
    except ModuleNotFoundError:
        sys.modules["resource"] = types.SimpleNamespace()


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


benchmark = load_module("fem_gpu_benchmark_contract", BENCHMARK_PATH)
nsight = load_module("capture_fem_gpu_nsight_contract", NSIGHT_PATH)


REQUIRED_RECORD_FIELDS = {
    "source_commit",
    "source_snapshot_sha256",
    "runtime_manifest_sha256",
    "problem_ir_sha256",
    "mesh_sha256",
    "gpu_uuid",
    "precision",
    "wall_time_p50_ns",
    "wall_time_p95_ns",
    "setup_count",
    "apply_count",
    "compute_fence_count",
    "kernel_launch_count",
}


def accepted_row(repeat_index: int) -> dict[str, object]:
    return {
        "status": "ok",
        "backend": "fem_gpu",
        "repeat_index": repeat_index,
        "runtime_git_commit": "a" * 40,
        "runtime_source_snapshot_sha256": "b" * 64,
        "runtime_manifest_sha256": "c" * 64,
        "runtime_dirty": "false",
        "binary": str(BENCHMARK_PATH),
        "runtime_launcher_path": str(BENCHMARK_PATH),
        "runtime_launcher_sha256": benchmark.hashlib.sha256(
            BENCHMARK_PATH.read_bytes()
        ).hexdigest(),
        "executed_problem_ir_sha256": "d" * 64,
        "qualification_fixture_problem_ir_sha256": "d" * 64,
        "solver_mesh_sha256": "e" * 64,
        "device_uuid": "GPU-01234567-89ab-cdef-0123-456789abcdef",
        "reported_precision": "double",
        "integrator": "heun",
        "wall_time_ms": 10.0 + repeat_index,
        "fem_gpu_execution_receipt": {
            "requested": "gpu",
            "resolved": "device_resident",
            "executed": "cuda_fem",
            "execution_class": "device_resident",
            "device_ordinal": 0,
            "precision": "double",
            "integrator": "heun",
            "required_operator_mask": 0x1FF,
            "resolved_device_operator_mask": 0x1FF,
            "resolved_host_operator_mask": 0,
            "resolved_unknown_operator_mask": 0,
            "executed_device_operator_mask": 0x1FF,
            "executed_host_operator_mask": 0,
            "executed_unknown_operator_mask": 0,
            "fallback_count": 0,
            "accepted_step_count": 64,
            "rejected_attempt_count": 0,
            "failed_attempt_count": 0,
            "hot_loop_compute_h2d_bytes": 0,
            "hot_loop_compute_d2h_bytes": 0,
            "hot_loop_compute_host_sync_count": 0,
            "accounting_valid": True,
        },
        "fem_gpu_performance_snapshot_v2": {
            "abi_version": 2,
            "struct_size": 88,
            "setup_count": 1,
            "apply_count": 64,
            "kernel_launch_count": 512,
            "compute_fence_count": 0,
            "snapshot_fence_count": 1,
            "export_fence_count": 1,
            "selected_sparse_kernel_id": 0,
            "setup_wall_time_ns": 100,
            "apply_wall_time_ns": 1_000,
            "accepted_finalization_wall_time_ns": 50,
        },
    }


class BenchmarkV2ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = [accepted_row(index) for index in range(5)]
        self.oracle = {"status": "checked", "failures": []}
        self.source_identity = {
            "head_commit_full": "a" * 40,
            "source_snapshot_sha256": "b" * 64,
            "source_snapshot_dirty": False,
        }
        self.workload_identity = {
            "problem_ir_sha256": "d" * 64,
            "mesh_sha256": "e" * 64,
            "qualification_fixture_problem_ir_sha256": "d" * 64,
        }

    def test_record_is_source_bound_complete_and_uses_five_repetitions(self) -> None:
        record = benchmark.collect_case(
            self.rows,
            cpu_oracle=self.oracle,
            expected_source_identity=self.source_identity,
            expected_workload_identity=self.workload_identity,
        )
        self.assertLessEqual(REQUIRED_RECORD_FIELDS, set(record))
        self.assertEqual(record["measured_repetitions"], 5)
        self.assertEqual(record["wall_time_p50_ns"], 12_000_000)
        self.assertEqual(record["wall_time_p95_ns"], 14_000_000)
        self.assertEqual(record["trace_scope"], "setup_to_export")
        duplicate = [dict(row) for row in self.rows]
        duplicate[-1]["repeat_index"] = 0
        with self.assertRaisesRegex(ValueError, "unique repeat_index"):
            benchmark.collect_case(
                duplicate,
                cpu_oracle=self.oracle,
                expected_source_identity=self.source_identity,
                expected_workload_identity=self.workload_identity,
            )

    def test_correctness_gate_runs_before_any_statistics_are_published(self) -> None:
        for field, expected in (
            ("runtime_git_commit", "source_commit"),
            ("runtime_source_snapshot_sha256", "source_snapshot_sha256"),
            ("executed_problem_ir_sha256", "problem_ir_sha256"),
            ("solver_mesh_sha256", "mesh_sha256"),
        ):
            with self.subTest(field=field):
                bad = [dict(row) for row in self.rows]
                bad[-1][field] = "f" * len(str(bad[-1][field]))
                payload = benchmark.build_benchmark_v2(
                    bad,
                    cpu_oracle=self.oracle,
                    expected_source_identity=self.source_identity,
                    expected_workload_identity=self.workload_identity,
                )
                self.assertEqual(payload["qualification_status"], "NOT VERIFIED")
                self.assertEqual(payload["records"], [])
                self.assertTrue(
                    any(expected in blocker for blocker in payload["blockers"])
                )

    def test_incomplete_receipt_strict_host_work_or_oracle_failure_rejects(self) -> None:
        cases: list[tuple[list[dict[str, object]], dict[str, object], str]] = []

        missing_snapshot = [dict(row) for row in self.rows]
        missing_snapshot[0].pop("fem_gpu_performance_snapshot_v2")
        cases.append((missing_snapshot, self.oracle, "performance snapshot"))

        missing_receipt = [dict(row) for row in self.rows]
        missing_receipt[0].pop("fem_gpu_execution_receipt")
        cases.append((missing_receipt, self.oracle, "execution receipt"))

        host_mask = [dict(row) for row in self.rows]
        receipt = dict(host_mask[0]["fem_gpu_execution_receipt"])
        receipt["executed_host_operator_mask"] = 1
        host_mask[0]["fem_gpu_execution_receipt"] = receipt
        cases.append((host_mask, self.oracle, "executed_host_operator_mask"))

        compute_fence = [dict(row) for row in self.rows]
        snapshot = dict(compute_fence[0]["fem_gpu_performance_snapshot_v2"])
        snapshot["compute_fence_count"] = 1
        compute_fence[0]["fem_gpu_performance_snapshot_v2"] = snapshot
        cases.append((compute_fence, self.oracle, "compute_fence_count"))

        oracle_failure = {
            "status": "failed",
            "failures": ["CPU oracle relative error 2e-4 exceeds tolerance 1e-6"],
        }
        cases.append((self.rows, oracle_failure, "CPU oracle"))

        for rows, oracle, expected in cases:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(ValueError, expected):
                    benchmark.collect_case(
                        rows,
                        cpu_oracle=oracle,
                        expected_source_identity=self.source_identity,
                        expected_workload_identity=self.workload_identity,
                    )

    def test_checkout_identity_must_match_and_be_clean(self) -> None:
        for update, expected in (
            ({"head_commit_full": "f" * 40}, "source_commit"),
            ({"source_snapshot_sha256": "f" * 64}, "source_snapshot_sha256"),
            ({"source_snapshot_dirty": True}, "dirty"),
        ):
            with self.subTest(update=update):
                identity = {**self.source_identity, **update}
                with self.assertRaisesRegex(ValueError, expected):
                    benchmark.collect_case(
                        self.rows,
                        cpu_oracle=self.oracle,
                        expected_source_identity=identity,
                        expected_workload_identity=self.workload_identity,
                    )

    def test_all_repetitions_must_match_canonical_workload_identity(self) -> None:
        for field, expected in (
            ("executed_problem_ir_sha256", "problem_ir_sha256"),
            ("solver_mesh_sha256", "mesh_sha256"),
            (
                "qualification_fixture_problem_ir_sha256",
                "qualification fixture problem_ir_sha256",
            ),
        ):
            with self.subTest(field=field):
                wrong = [{**row, field: "f" * 64} for row in self.rows]
                payload = benchmark.build_benchmark_v2(
                    wrong,
                    cpu_oracle=self.oracle,
                    expected_source_identity=self.source_identity,
                    expected_workload_identity=self.workload_identity,
                )
                self.assertEqual(payload["qualification_status"], "NOT VERIFIED")
                self.assertEqual(payload["records"], [])
                self.assertTrue(
                    any(expected in blocker for blocker in payload["blockers"])
                )

        aliased_identity = {
            **self.workload_identity,
            "qualification_fixture_problem_ir_sha256": "f" * 64,
        }
        payload = benchmark.build_benchmark_v2(
            self.rows,
            cpu_oracle=self.oracle,
            expected_source_identity=self.source_identity,
            expected_workload_identity=aliased_identity,
        )
        self.assertEqual(payload["qualification_status"], "NOT VERIFIED")
        self.assertEqual(payload["records"], [])
        self.assertTrue(
            any("differs from canonical workload" in item for item in payload["blockers"])
        )

    def test_runtime_bundle_identity_rejects_tampered_binaries(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = {
                "launcher": root / "bin" / "fullmag-fem-gpu",
                "worker": root / "bin" / "fullmag-fem-gpu-bin",
                "api": root / "bin" / "fullmag-api",
            }
            library = root / "lib" / "libfullmag_fem.so"
            for name, path in {**paths, "fullmag_fem": library}.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(name.encode("ascii"))
            sha256 = benchmark.hashlib.sha256
            manifest = {
                "schema": 3,
                "source_provenance": {
                    "git_commit": "a" * 40,
                    "git_tree": "b" * 40,
                    "dirty": False,
                    "dirty_patch_sha256": None,
                    "source_inputs_sha256": "c" * 64,
                },
                "binaries": {
                    name: str(path.relative_to(root)) for name, path in paths.items()
                },
                "integrity": {
                    f"{name}_sha256": sha256(path.read_bytes()).hexdigest()
                    for name, path in paths.items()
                },
                "native_libraries": {
                    "fullmag_fem": {
                        "path": str(library.relative_to(root)),
                        "sha256": sha256(library.read_bytes()).hexdigest(),
                    }
                },
            }
            (root / "manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )
            benchmark.runtime_bundle_identity(root, require_integrity=True)
            paths["worker"].write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "worker sha256 mismatch"):
                benchmark.runtime_bundle_identity(root, require_integrity=True)
            paths["worker"].write_bytes(b"worker")
            for native_libraries in ({}, {"mfem": {}}):
                manifest["native_libraries"] = native_libraries
                (root / "manifest.json").write_text(
                    json.dumps(manifest), encoding="utf-8"
                )
                with self.assertRaisesRegex(ValueError, "fullmag_fem"):
                    benchmark.runtime_bundle_identity(root, require_integrity=True)

    def test_executed_binary_must_be_the_manifested_launcher(self) -> None:
        wrong_binary = [dict(row) for row in self.rows]
        wrong_binary[0]["binary"] = str(NSIGHT_PATH)
        with self.assertRaisesRegex(ValueError, "executed binary"):
            benchmark.collect_case(
                wrong_binary,
                cpu_oracle=self.oracle,
                expected_source_identity=self.source_identity,
                expected_workload_identity=self.workload_identity,
            )

    def test_preconditioner_cli_has_one_canonical_runtime_mapping(self) -> None:
        self.assertEqual(
            benchmark.RELAXATION_PRECONDITIONER_RUNTIME_NAMES,
            {
                "none": "none",
                "diagonal": "diagonal",
                "exchange_mass": None,
            },
        )
        self.assertEqual(
            benchmark.resolve_relaxation_preconditioner_strategies(
                "none,diagonal"
            ),
            ["none", "diagonal"],
        )
        with self.assertRaisesRegex(ValueError, "unsupported"):
            benchmark.resolve_relaxation_preconditioner_strategies(
                "exchange_mass"
            )
        with self.assertRaisesRegex(ValueError, "unsupported"):
            benchmark.resolve_relaxation_preconditioner_strategies(
                "lumped_exchange_mass_cg8"
            )

    def test_writer_emits_json_and_p50_p95_csv_without_overwriting(self) -> None:
        payload = benchmark.build_benchmark_v2(
            self.rows,
            cpu_oracle=self.oracle,
            expected_source_identity=self.source_identity,
            expected_workload_identity=self.workload_identity,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            json_path = root / "benchmark.v2.json"
            csv_path = root / "benchmark.v2.csv"
            benchmark.write_benchmark_v2(
                payload,
                json_path=json_path,
                csv_path=csv_path,
                immutable=True,
            )
            written = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(written["schema"], "fullmag.fem_gpu.benchmark.v2")
            self.assertEqual(written["qualification_status"], "VERIFIED")
            with csv_path.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(rows[0]["wall_time_p50_ns"], "12000000")
            self.assertEqual(rows[0]["wall_time_p95_ns"], "14000000")
            with self.assertRaisesRegex(FileExistsError, "immutable"):
                benchmark.write_benchmark_v2(
                    payload,
                    json_path=json_path,
                    csv_path=csv_path,
                    immutable=True,
                )

    def test_atomic_writer_supports_distinct_attempts_without_partial_marker(self) -> None:
        payload = benchmark.build_benchmark_v2(
            self.rows,
            cpu_oracle=self.oracle,
            expected_source_identity=self.source_identity,
            expected_workload_identity=self.workload_identity,
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / ("a" * 40)
            first = root / "attempt-1"
            second = root / "attempt-2"
            benchmark.write_benchmark_v2(
                benchmark.not_verified_benchmark_v2("precondition unavailable"),
                json_path=first / "benchmark.v2.json",
                csv_path=first / "benchmark.v2.csv",
                immutable=True,
            )
            benchmark.write_benchmark_v2(
                payload,
                json_path=second / "benchmark.v2.json",
                csv_path=second / "benchmark.v2.csv",
                immutable=True,
            )
            self.assertEqual(
                json.loads((first / "benchmark.v2.json").read_text())["qualification_status"],
                "NOT VERIFIED",
            )
            self.assertEqual(
                json.loads((second / "benchmark.v2.json").read_text())["qualification_status"],
                "VERIFIED",
            )

            broken_json = root / "broken" / "benchmark.v2.json"
            broken_csv = root / "broken" / "benchmark.v2.csv"
            broken = {
                **payload,
                "records": [payload["records"][0], {"unexpected": 1}],
            }
            with self.assertRaises(ValueError):
                benchmark.write_benchmark_v2(
                    broken,
                    json_path=broken_json,
                    csv_path=broken_csv,
                    immutable=True,
                )
            self.assertFalse(broken_json.exists())
            self.assertFalse(broken_csv.exists())

            overwrite_json = root / "overwrite" / "benchmark.v2.json"
            overwrite_csv = root / "overwrite" / "benchmark.v2.csv"
            overwrite_json.parent.mkdir(parents=True)
            overwrite_json.write_text('{"qualification_status":"VERIFIED"}\n')
            overwrite_csv.write_text("stale\n")
            with self.assertRaises(ValueError):
                benchmark.write_benchmark_v2(
                    broken,
                    json_path=overwrite_json,
                    csv_path=overwrite_csv,
                    immutable=False,
                )
            self.assertFalse(overwrite_json.exists())
            self.assertEqual(overwrite_csv.read_text(), "stale\n")


class NsightPhaseContractTests(unittest.TestCase):
    def test_setup_to_export_phase_contract_is_fail_closed(self) -> None:
        self.assertEqual(
            tuple(nsight.TRACE_PHASE_RANGES),
            ("setup", "attempt", "accepted_finalization", "snapshot", "export"),
        )
        ordered = [
            {
                "kind": "nvtx",
                "name": values[0],
                "start_ns": index * 10,
                "end_ns": index * 10 + 5,
            }
            for index, values in enumerate(nsight.TRACE_PHASE_RANGES.values())
        ]
        self.assertEqual(nsight.ordered_trace_phase_failures(ordered), [])
        split_compute = ordered[:2]
        split_host = ordered[2:]
        self.assertTrue(nsight.ordered_trace_phase_failures(split_compute))
        self.assertTrue(nsight.ordered_trace_phase_failures(split_host))
        out_of_order = [dict(event) for event in ordered]
        out_of_order[1]["start_ns"] = 25
        out_of_order[1]["end_ns"] = 29
        out_of_order[2]["start_ns"] = 10
        out_of_order[2]["end_ns"] = 15
        self.assertTrue(nsight.ordered_trace_phase_failures(out_of_order))

    def test_unavailable_capture_is_explicitly_not_verified(self) -> None:
        payload = nsight.not_verified_payload(
            run_id="missing-tools",
            blockers=["nsys unavailable"],
        )
        self.assertEqual(payload["qualification_status"], "NOT VERIFIED")
        self.assertEqual(payload["trace_scope"]["from"], "setup")
        self.assertEqual(payload["trace_scope"]["through"], "export")


class ManagedRecipeContractTests(unittest.TestCase):
    def test_baseline_and_nsight_recipes_are_v2_immutable_and_honest(self) -> None:
        justfile = (ROOT / "justfile").read_text(encoding="utf-8")
        baseline = justfile.split(
            "capture-fem-gpu-pre-remediation-performance-baseline:", 1
        )[1].split("\n\n", 1)[0]
        nsight_recipe = justfile.split("capture-fem-gpu-nsight:", 1)[1].split(
            "\n\n", 1
        )[0]
        self.assertIn("benchmark.v2.json", baseline)
        self.assertIn("--repeat 5", baseline)
        self.assertIn("--benchmark-v2-immutable", baseline)
        self.assertIn("--gpu-host-thread-qualification-run", baseline)
        self.assertIn("just rebuild-fem-runtime", baseline)
        self.assertIn("$source_commit/$attempt_id", baseline)
        self.assertIn("scripts/windows/run_fullmag_fem.ps1", baseline)
        self.assertIn("-Contract gpu-benchmark-baseline", baseline)
        self.assertNotIn("lumped_exchange_mass_cg8", baseline)
        self.assertIn("scripts/windows/run_fullmag_fem.ps1", nsight_recipe)
        self.assertIn("-Contract gpu-nsight", nsight_recipe)
        baseline_windows = baseline.split("MINGW*|MSYS*|CYGWIN*)", 1)[1].split(
            ";;", 1
        )[0]
        nsight_windows = nsight_recipe.split("MINGW*|MSYS*|CYGWIN*)", 1)[1].split(
            ";;", 1
        )[0]
        self.assertNotIn("--record-benchmark-v2-not-verified", baseline_windows)
        self.assertNotIn("--record-not-verified", nsight_windows)

        launcher = (
            ROOT / "scripts" / "windows" / "run_fullmag_fem.ps1"
        ).read_text(encoding="utf-8")
        self.assertIn(
            '[ValidateSet("gpu-execution-receipt", "gpu-benchmark-baseline", "gpu-nsight")]',
            launcher,
        )
        self.assertIn("compose.windows.yaml", launcher)
        self.assertIn('$Contract -eq "gpu-benchmark-baseline"', launcher)
        self.assertIn('$Contract -eq "gpu-nsight"', launcher)
        self.assertIn("FULLMAG_FEM_EXECUTION=gpu", launcher)
        self.assertIn("CPU fallback is forbidden", launcher)
        self.assertIn("NOT VERIFIED", launcher)


if __name__ == "__main__":
    unittest.main()
