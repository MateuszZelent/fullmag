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
            "requested": "strict_device",
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
            "setup_count": 64,
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

    def test_gpu_snapshot_is_loaded_from_published_runner_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "performance").mkdir()
            metadata = {
                "status": "completed",
                "scalar_rows": 1,
                "execution_provenance": {
                    "fem_gpu_performance_snapshot_v2": {
                        "abi_version": 2,
                        "struct_size": 88,
                        "setup_count": 999,
                    }
                },
            }
            (root / "metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )
            (root / "scalars.csv").write_text(
                "time,E_total\n0,0\n", encoding="utf-8"
            )
            published = {
                "abi_version": 2,
                "struct_size": 88,
                "setup_count": 1,
                "apply_count": 64,
                "kernel_launch_count": 512,
                "compute_fence_count": 0,
            }
            (root / "performance" / "fem_gpu_performance_snapshot.v2.json").write_text(
                json.dumps(
                    {
                        "schema": "fullmag.fem_gpu_performance_snapshot.v2",
                        "snapshot": published,
                    }
                ),
                encoding="utf-8",
            )

            payload = benchmark.load_authoritative_benchmark_payload(root)

            self.assertIsNotNone(payload)
            assert payload is not None
            self.assertEqual(
                payload["fem_gpu_performance_snapshot_v2"], published
            )
            self.assertEqual(
                benchmark._select_performance_snapshot(
                    "fem_gpu",
                    artifact_payload=payload,
                    metadata=metadata,
                    payload=metadata,
                ),
                published,
            )
            self.assertIsNone(
                benchmark._select_performance_snapshot(
                    "fem_gpu",
                    artifact_payload={"status": "completed"},
                    metadata=metadata,
                    payload=metadata,
                )
            )

    def test_nsight_bundle_identity_rehashes_declared_binaries_and_fullmag_fem(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            binaries = {
                name: root / "bin" / filename
                for name, filename in (
                    ("launcher", "fullmag-fem-gpu"),
                    ("worker", "fullmag-fem-gpu-bin"),
                    ("api", "fullmag-api"),
                )
            }
            fullmag_fem = root / "lib" / "libfullmag_fem.so"
            for path in {
                **binaries,
                "fullmag_fem": fullmag_fem,
            }.values():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(path.name.encode("ascii"))
            digest = lambda path: benchmark.hashlib.sha256(path.read_bytes()).hexdigest()
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
                    name: str(path.relative_to(root))
                    for name, path in binaries.items()
                },
                "integrity": {
                    f"{name}_sha256": digest(path)
                    for name, path in binaries.items()
                },
                "native_libraries": {
                    "fullmag_fem": {
                        "path": str(fullmag_fem.relative_to(root)),
                        "sha256": digest(fullmag_fem),
                    }
                },
            }
            (root / "manifest.json").write_text(
                json.dumps(manifest), encoding="utf-8"
            )

            identity = nsight.collect_bundle_identity(root)

            self.assertEqual(identity["binaries"]["launcher"], digest(binaries["launcher"]))
            self.assertEqual(identity["binaries"]["worker"], digest(binaries["worker"]))
            self.assertEqual(identity["binaries"]["api"], digest(binaries["api"]))
            self.assertEqual(identity["libraries"]["fullmag_fem"], digest(fullmag_fem))
            binaries["worker"].write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "worker sha256 mismatch"):
                nsight.collect_bundle_identity(root)
            binaries["worker"].write_bytes(binaries["worker"].name.encode("ascii"))
            fullmag_fem.write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "fullmag_fem sha256 mismatch"):
                nsight.collect_bundle_identity(root)

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
                "exchange_mass_cg4": "exchange_mass_cg4",
                "exchange_mass_cg8": "exchange_mass_cg8",
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


class DirectMinimizerBenchmarkContractTests(unittest.TestCase):
    def direct_minimizer_rows(self) -> list[dict[str, object]]:
        rows: list[dict[str, object]] = []
        for algorithm in ("nonlinear_cg", "projected_gradient_bb"):
            for strategy in (
                "none",
                "diagonal",
                "exchange_mass_cg4",
                "exchange_mass_cg8",
            ):
                for mesh_size in ("coarse", "medium", "fine"):
                    for repeat_index in range(5):
                        row = accepted_row(repeat_index)
                        row.update(
                            {
                                "reported_relaxation_algorithm": algorithm,
                                "requested_relaxation_preconditioner_strategy": strategy,
                                "mesh_size": mesh_size,
                                "final_artifact_status": "ready",
                                "final_artifact_sha256": "f" * 64,
                                "receipt_final_artifact_sha256": "f" * 64,
                            }
                        )
                        rows.append(row)
        return rows

    def test_matrix_requires_exactly_five_valid_repeat_indices(self) -> None:
        summary = benchmark.direct_minimizer_benchmark_matrix_summary(
            self.direct_minimizer_rows()
        )

        self.assertTrue(summary["matrix_complete"])
        self.assertEqual(summary["qualification_status"], "NOT VERIFIED")
        self.assertEqual(summary["measured_repetitions"], 5)

    def test_matrix_rejects_duplicate_and_missing_repeat_indices(self) -> None:
        rows = self.direct_minimizer_rows()
        rows[4]["repeat_index"] = 0
        summary = benchmark.direct_minimizer_benchmark_matrix_summary(rows)

        self.assertFalse(summary["matrix_complete"])
        self.assertTrue(
            any("repeat_index" in failure for failure in summary["failures"])
        )

    def test_matrix_binds_source_workload_mesh_gpu_runtime_and_final_artifact(self) -> None:
        fields = (
            ("runtime_git_commit", "source"),
            ("runtime_source_snapshot_sha256", "source"),
            ("executed_problem_ir_sha256", "workload"),
            ("solver_mesh_sha256", "mesh"),
            ("device_uuid", "GPU"),
            ("runtime_manifest_sha256", "runtime"),
            ("final_artifact_sha256", "artifact"),
        )
        for field, expected in fields:
            with self.subTest(field=field):
                rows = self.direct_minimizer_rows()
                rows[-1][field] = "0" * 64 if "sha256" in field else "other"
                summary = benchmark.direct_minimizer_benchmark_matrix_summary(rows)
                self.assertFalse(summary["matrix_complete"])
                self.assertTrue(
                    any(expected.lower() in failure.lower() for failure in summary["failures"])
                )

        rows = self.direct_minimizer_rows()
        rows[-1]["final_artifact_status"] = "incomplete"
        summary = benchmark.direct_minimizer_benchmark_matrix_summary(rows)
        self.assertTrue(any("artifact" in failure for failure in summary["failures"]))

    def test_matrix_keeps_algorithms_and_fixed_cg_variants_distinct(self) -> None:
        summary = benchmark.direct_minimizer_benchmark_matrix_summary(
            self.direct_minimizer_rows()
        )

        self.assertEqual(
            summary["algorithms"], ["nonlinear_cg", "projected_gradient_bb"]
        )
        self.assertEqual(
            summary["strategies"],
            ["none", "diagonal", "exchange_mass_cg4", "exchange_mass_cg8"],
        )
        rows = self.direct_minimizer_rows()
        rows[-1]["reported_relaxation_algorithm"] = "nonlinear_cg"
        summary = benchmark.direct_minimizer_benchmark_matrix_summary(rows)
        self.assertFalse(summary["matrix_complete"])
        self.assertTrue(any("matrix key" in failure for failure in summary["failures"]))

    def test_write_direct_minimizer_benchmark_matrix_summary(self) -> None:
        import tempfile
        import csv
        with tempfile.TemporaryDirectory() as tmpdir:
            csv_path = Path(tmpdir) / "matrix.csv"
            json_path = Path(tmpdir) / "summary.json"
            rows = self.direct_minimizer_rows()
            with csv_path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                writer.writeheader()
                writer.writerows(rows)
            summary = benchmark.write_direct_minimizer_benchmark_matrix_summary(
                csv_path, json_path
            )
            self.assertTrue(json_path.is_file())
            self.assertTrue(summary["matrix_complete"])
            loaded = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(
                loaded["schema"],
                "fullmag.fem_gpu.direct_minimizer_benchmark_matrix.v1",
            )


class NsightPhaseContractTests(unittest.TestCase):
    def test_production_emits_missing_setup_and_accepted_finalization_ranges(self) -> None:
        gpu_setup = (
            ROOT
            / "backends"
            / "fem"
            / "gpu"
            / "cuda"
            / "runtime"
            / "gpu_state_runtime.cpp"
        ).read_text(encoding="utf-8")
        nonlinear_cg = (
            ROOT
            / "backends"
            / "fem"
            / "gpu"
            / "cuda"
            / "relaxation"
            / "nonlinear_cg.cpp"
        ).read_text(encoding="utf-8")
        self.assertIn('FULLMAG_NVTX_RANGE("fem.gpu.setup")', gpu_setup)
        self.assertIn(
            'FULLMAG_NVTX_RANGE("fem.gpu.accepted_finalization")',
            nonlinear_cg,
        )

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
            '[ValidateSet("gpu-execution-receipt", "dmi-gpu", "gpu-benchmark-baseline", "gpu-nsight")]',
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
