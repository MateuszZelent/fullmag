"""Interpreted artifact checks; no native/unit target compilation."""
import csv
import json
import tempfile
import unittest
from pathlib import Path

from report_run_performance import Series, analyze


class PerformanceArtifacts(unittest.TestCase):
    def fixture(self, root, capture="available_for_observed_callback_intervals"):
        (root / "summary.json").write_text(json.dumps({
            "schema": "fullmag.run_performance.v1", "elapsed_monotonic_ns": 4_000_000_000,
            "coverage": {"accepted_step_index_span": 2}, "callback_latency_availability": capture,
        }))
        with (root / "steps.csv").open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["elapsed_monotonic_ns", "step_index", "step_gap_since_previous", "callback_delta_ns_per_step_gap"])
            writer.writerow([0, 0, "", ""])
            writer.writerow([2_000_000_000, 2, 2, 1_000_000_000])
        with (root / "resources.csv").open("w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["elapsed_monotonic_ns", "cpu_process_percent", "rss_bytes", "gpu_json"])
            writer.writerow([0, 250, 1024, json.dumps({"uuid": "GPU-test", "utilization_percent": 0})])
            writer.writerow([2_000_000_000, 150, 2048, json.dumps({"utilization_percent": None, "reason": "unsupported"})])

    def test_gap_coverage_and_zero_gpu_are_not_synthesized_or_missing(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            self.fixture(root)
            report, _ = analyze(root)
            self.assertEqual(report["observed_step_rows"], 2)
            self.assertEqual(report["observed_steps_per_second"], 1)
            self.assertEqual(report["stage_steps_per_second"], 0.5)
            self.assertEqual(report["nonunit_gap_rows"], 1)
            self.assertEqual(report["resources"]["gpu_percent"], {"samples": 1, "mean": 0, "min": 0, "max": 0})
            self.assertEqual(report["gpu_unavailable_samples"], 1)
            self.assertEqual(report["resources"]["cpu_percent"]["mean"], 200)

    def test_terminal_replay_has_no_callback_throughput_claim(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            self.fixture(root, "terminal_replay_no_callback")
            report, _ = analyze(root)
            self.assertIsNone(report["observed_steps_per_second"])

    def test_duplicate_steps_are_rejected(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            self.fixture(root)
            with (root / "steps.csv").open("a") as f:
                f.write("3000000000,2,0,0\n")
            with self.assertRaises(ValueError):
                analyze(root)

    def test_plot_memory_is_bounded_and_covers_the_full_run(self):
        series = Series(100, bins=16)
        for i in range(100_000):
            series.add("test", i / 1000, float(i))
        self.assertEqual(len(series.values["test"]), 16)
        _, y = series.points("test")
        self.assertGreater(y[-1], 90_000)


if __name__ == "__main__":
    unittest.main()
