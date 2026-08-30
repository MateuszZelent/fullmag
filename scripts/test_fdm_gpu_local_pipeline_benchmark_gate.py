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
                        }
                    )
    return result


class BenchmarkGateTests(unittest.TestCase):
    def test_complete_matrix_passes(self):
        payload = gate.evaluate(records(), 3, "a" * 40, "b" * 64)
        self.assertEqual(payload["status"], "pass")
        self.assertEqual(len(payload["cases"]), 6)

    def test_regression_fails(self):
        fixture = records()
        for record in fixture:
            if record["cells"] == 1024 and record["precision"] == "fp64" and record[
                "executed_realization"
            ] == "direct_fused":
                record["ns_per_step"] = 101.0
        with self.assertRaisesRegex(ValueError, "performance budget exceeded"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_checksum_drift_fails(self):
        fixture = records()
        fixture[0]["checksum"] += 1.0
        with self.assertRaisesRegex(ValueError, "checksum parity failed"):
            gate.evaluate(fixture, 3, "a" * 40, "b" * 64)

    def test_output_inside_repository_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside the Git repository"):
            gate._assert_outside_repository(Path(__file__).resolve().parent / "bad.json")


if __name__ == "__main__":
    unittest.main()
