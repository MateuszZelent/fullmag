import unittest
from pathlib import Path

from scripts import fdm_gpu_local_pipeline_benchmark_gate as gate


def records(repetitions: int = 3):
    result = []
    for precision in gate.EXPECTED_PRECISIONS:
        for cells in gate.EXPECTED_CELLS:
            checksum = float(cells) + (0.5 if precision == "fp32" else 0.0)
            for _ in range(repetitions):
                for realization, latency in (
                    ("direct_fused", 90.0),
                    ("direct_unfused", 100.0),
                ):
                    fused = realization == "direct_fused"
                    result.append(
                        {
                            "schema": gate.RECORD_SCHEMA,
                            "cells": cells,
                            "warmup_steps": 8,
                            "measured_steps": 10,
                            "precision": precision,
                            "requested_policy": "auto_safe",
                            "resolved_realization": realization,
                            "executed_realization": realization,
                            "fused_launches": 36 if fused else 0,
                            "unfused_field_launches": 0 if fused else 36,
                            "unfused_rhs_launches": 0 if fused else 36,
                            "ns_per_step": latency,
                            "checksum": checksum,
                            "device": "test gpu",
                            "compute_capability": "8.6",
                            "kernel_resources_schema":
                                "fullmag.fdm_gpu.local_pipeline_kernel_resources.v1",
                            "kernel_block_threads": 256,
                            "kernel_registers_per_thread":
                                96 if precision == "fp64" else 80,
                            "kernel_static_shared_bytes": 0,
                            "kernel_local_bytes_per_thread": 0,
                            "kernel_max_active_blocks_per_sm": 2,
                            "kernel_max_threads_per_sm": 1536,
                            "kernel_multiprocessor_count": 46,
                            "kernel_theoretical_occupancy_permyriad": 3333,
                        }
                    )
    return result


class BenchmarkGateTests(unittest.TestCase):
    def test_complete_matrix_passes(self):
        payload = gate.evaluate(records(), 3, "a" * 40, "b" * 64)
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(len(payload["cases"]), 6)
        self.assertEqual(payload["policy"]["small_medium_maximum_ratio"], 1.01)

    def test_small_medium_measurement_noise_within_budget_passes(self):
        fixture = records()
        for record in fixture:
            if record["cells"] == 1024 and record["precision"] == "fp64" and record[
                "executed_realization"
            ] == "direct_fused":
                record["ns_per_step"] = 100.9
        payload = gate.evaluate(fixture, 3, "a" * 40, "b" * 64)
        self.assertEqual(payload["status"], "pass")

    def test_small_medium_regression_above_budget_fails(self):
        fixture = records()
        for record in fixture:
            if record["cells"] == 1024 and record["precision"] == "fp64" and record[
                "executed_realization"
            ] == "direct_fused":
                record["ns_per_step"] = 101.1
        with self.assertRaisesRegex(ValueError, "performance budget exceeded"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_checksum_drift_fails(self):
        fixture = records()
        fixture[0]["checksum"] += 1.0
        with self.assertRaisesRegex(ValueError, "checksum parity failed"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_kernel_local_memory_spill_fails(self):
        fixture = records()
        for record in fixture:
            record["kernel_local_bytes_per_thread"] = 8
        with self.assertRaisesRegex(ValueError, "local-memory spill budget"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_kernel_register_pressure_fails(self):
        fixture = records()
        for record in fixture:
            record["kernel_registers_per_thread"] = 129
        with self.assertRaisesRegex(ValueError, "register budget"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_kernel_theoretical_occupancy_fails(self):
        fixture = records()
        for record in fixture:
            record["kernel_max_active_blocks_per_sm"] = 1
            record["kernel_theoretical_occupancy_permyriad"] = 1666
        with self.assertRaisesRegex(ValueError, "theoretical occupancy budget"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_output_inside_repository_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside the Git repository"):
            gate._assert_outside_repository(Path(__file__).resolve().parent / "bad.json")


if __name__ == "__main__":
    unittest.main()
