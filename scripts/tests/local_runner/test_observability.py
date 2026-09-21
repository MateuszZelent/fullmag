"""Unit tests for local_runner.observability telemetry and storage inventory."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT_ROOT = Path(__file__).resolve().parents[2]
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from local_runner.observability import ObservabilityHub, build_job_timeline  # noqa: E402


class ObservabilityTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.hub = ObservabilityHub(self.root, owner="test-operator")

    def test_event_recording_and_limiting(self):
        # Default startup events are present
        events = self.hub.get_events(limit=10)
        self.assertGreaterEqual(len(events), 2)
        self.assertEqual("runner_started", events[0]["event"])

        # Record custom event
        rec = self.hub.record_event("WARN", "disk_warning", "Disk low", job_id="job-123", profile="fem-cpu")
        self.assertEqual("WARN", rec["level"])
        self.assertEqual("job-123", rec["job_id"])

        # Filtering by level and job_id
        warns = self.hub.get_events(level="WARN")
        self.assertTrue(any(e["event"] == "disk_warning" for e in warns))

        job_events = self.hub.get_events(job_id="job-123")
        self.assertEqual(1, len(job_events))
        self.assertEqual("disk_warning", job_events[0]["event"])

    def test_metrics_sampling_and_trends(self):
        trends = self.hub.get_metrics_trends()
        self.assertGreaterEqual(len(trends), 1)
        first = trends[0]
        self.assertIn("disk_free_gb", first)
        self.assertIn("storage_growth_mb", first)
        self.assertIn("ram_mb", first)
        self.assertIn("cpu_percent", first)
        self.assertIn("io_mb_s", first)

        new_sample = self.hub.sample_metrics()
        self.assertIn("timestamp", new_sample)
        self.assertEqual("coordinator", new_sample.get("scope"))
        self.assertGreaterEqual(new_sample["disk_free_gb"], 0)

    def test_metrics_history_persistence_and_periodic_sampling(self):
        index_dir = self.root / "index"
        index_dir.mkdir(parents=True, exist_ok=True)
        old_history = [
            {
                "timestamp": "2026-09-01T10:00:00+00:00",
                "disk_free_gb": 40.0,
                "storage_growth_mb": 0.0,
                "ram_mb": 100.0,
                "cpu_percent": 10.0,
                "io_mb_s": 0.5,
            }
        ]
        (index_dir / "metrics-history.json").write_text(json.dumps(old_history), encoding="utf-8")

        fresh_hub = ObservabilityHub(self.root, owner="test-operator")
        samples = fresh_hub.get_metrics_trends()
        self.assertGreaterEqual(len(samples), 2)
        self.assertEqual("2026-09-01T10:00:00+00:00", samples[0]["timestamp"])
        self.assertNotEqual("2026-09-01T10:00:00+00:00", samples[-1]["timestamp"])

    def test_storage_volumes_structure_and_thresholds(self):
        vols = self.hub.get_storage_volumes()
        self.assertEqual(2, len(vols))
        storage_vol = vols[0]
        self.assertEqual("storage-root", storage_vol["id"])
        self.assertGreater(storage_vol["total_bytes"], 0)
        self.assertGreater(storage_vol["warning_threshold_bytes"], 0)
        self.assertGreater(storage_vol["critical_threshold_bytes"], 0)
        self.assertIn(storage_vol["status"], ("healthy", "warning", "critical"))

    def test_resource_categorization_and_pinning(self):
        # Create simulated storage directories
        runs_dir = self.root / "runs" / "master" / "job-001"
        (runs_dir / "source").mkdir(parents=True)
        (runs_dir / "source" / "code.rs").write_text("fn main() {}", encoding="utf-8")

        (runs_dir / "execution").mkdir(parents=True)
        (runs_dir / "execution" / "temp.o").write_bytes(b"\x00" * 2048)

        (runs_dir / "artifacts").mkdir(parents=True)
        (runs_dir / "artifacts" / "receipt.json").write_text("{}", encoding="utf-8")

        builds_dir = self.root / "builds" / "fem-cpu-release"
        builds_dir.mkdir(parents=True)
        (builds_dir / "binary").write_bytes(b"\x00" * 4096)

        cache_dir = self.root / "cache" / "cargo-registry"
        cache_dir.mkdir(parents=True)
        (cache_dir / "index").write_bytes(b"\x00" * 1024)

        index_dir = self.root / "index"
        index_dir.mkdir(parents=True)
        (index_dir / "runner-jobs.sqlite").write_bytes(b"\x00" * 512)

        inv = self.hub.get_storage_resources()
        resources = inv["resources"]
        res_map = {r["resource_id"]: r for r in resources}

        exec_res_id = "exec-master-job-001"
        target_res_id = "target-fem-cpu-release"
        self.assertIn(exec_res_id, res_map)
        self.assertIn(target_res_id, res_map)

        # Initially execution tree is unpinned and fail-closed protected (no queue provided)
        self.assertFalse(res_map[exec_res_id]["pinned"])
        self.assertFalse(res_map[exec_res_id]["eligible_for_retention"])

        # Pin execution tree
        pin_res = self.hub.set_pinned(exec_res_id, True, "Diagnostyka awarii numerics")
        self.assertTrue(pin_res["pinned"])

        # Pin build target
        self.hub.set_pinned(target_res_id, True, "Zachowaj profil do testow")

        # Reload inventory and verify pinned state and reasons
        inv_after = self.hub.get_storage_resources()
        res_map_after = {r["resource_id"]: r for r in inv_after["resources"]}

        self.assertTrue(res_map_after[exec_res_id]["pinned"])
        self.assertEqual("Diagnostyka awarii numerics", res_map_after[exec_res_id]["why_retained"])
        self.assertFalse(res_map_after[exec_res_id]["eligible_for_retention"])

        self.assertTrue(res_map_after[target_res_id]["pinned"])
        self.assertEqual("Zachowaj profil do testow", res_map_after[target_res_id]["why_retained"])

        # Unpin execution tree
        self.hub.set_pinned(exec_res_id, False)
        inv_unpinned = self.hub.get_storage_resources()
        res_map_unpinned = {r["resource_id"]: r for r in inv_unpinned["resources"]}
        self.assertFalse(res_map_unpinned[exec_res_id]["pinned"])
        self.assertFalse(res_map_unpinned[exec_res_id]["eligible_for_retention"])

    def test_retention_plan_generation_and_safe_apply(self):
        plan = self.hub.generate_retention_plan()
        self.assertIn("plan_id", plan)
        self.assertEqual("preview", plan["status"])
        self.assertIn("candidates", plan)
        self.assertIn("retained", plan)

        apply_res = self.hub.apply_retention_plan(plan["plan_id"])
        self.assertFalse(apply_res["applied"])
        self.assertEqual("preview_only", apply_res.get("status"))
        self.assertEqual(0, apply_res.get("reclaimed_bytes"))
        self.assertEqual(plan["plan_id"], apply_res["plan_id"])

        # Nonexistent plan returns applied=False
        err_res = self.hub.apply_retention_plan("nonexistent-plan")
        self.assertFalse(err_res["applied"])

    def test_retention_policy_crud(self):
        default_policy = self.hub.get_retention_policy()
        self.assertEqual("preview", default_policy["mode"])
        self.assertEqual(24, default_policy["ttl_success_hours"])

        updated = self.hub.set_retention_policy({"mode": "automatic", "ttl_success_hours": 48})
        self.assertEqual("preview", updated["mode"])
        self.assertEqual("automatic", updated.get("requested_mode"))
        self.assertEqual("not_implemented", updated.get("mode_status"))
        self.assertEqual(48, updated["ttl_success_hours"])

        # Re-fetch confirms persistence on disk
        persisted = self.hub.get_retention_policy()
        self.assertEqual("preview", persisted["mode"])
        self.assertEqual(48, persisted["ttl_success_hours"])

    def test_build_job_timeline_decomposition(self):
        job = {
            "job_id": "job-timeline-test",
            "worktree_id": "wt-1",
            "state": "running",
            "created_at": time.time() - 30,
            "started_at": time.time() - 25,
        }

        # No log files on disk -> queued and prepare done, native-build running
        stages = build_job_timeline(job, self.root)
        self.assertEqual(7, len(stages))
        self.assertEqual("succeeded", stages[0]["status"])  # queued
        self.assertEqual("succeeded", stages[1]["status"])  # prepare
        self.assertEqual("running", stages[2]["status"])    # native-build

        # Empty log file should NOT mark stage as succeeded (R5 verification)
        runs_dir = self.root / "runs" / "wt-1" / "job-timeline-test" / "artifacts" / "logs"
        runs_dir.mkdir(parents=True)
        (runs_dir / "native-build.stdout.log").write_text("", encoding="utf-8")
        stages_empty_log = build_job_timeline(job, self.root)
        self.assertEqual("running", stages_empty_log[2]["status"])  # native-build is running

        # When frontend-dependencies log appears, native-build succeeded and dependencies are running
        (runs_dir / "frontend-dependencies.stdout.log").write_text("Packages installing...\n", encoding="utf-8")
        stages_stage3 = build_job_timeline(job, self.root)
        self.assertEqual("succeeded", stages_stage3[2]["status"])  # native-build succeeded
        self.assertEqual("running", stages_stage3[3]["status"])    # frontend-dependencies running
        self.assertEqual("pending", stages_stage3[4]["status"])    # frontend-build pending

        # When frontend-build log appears, dependencies succeeded and build is running
        (runs_dir / "frontend-build.stdout.log").write_text("Vite building...\n", encoding="utf-8")
        stages_stage4 = build_job_timeline(job, self.root)
        self.assertEqual("succeeded", stages_stage4[2]["status"])  # native-build succeeded
        self.assertEqual("succeeded", stages_stage4[3]["status"])  # frontend-dependencies succeeded
        self.assertEqual("running", stages_stage4[4]["status"])    # frontend-build running

        # Verify receipt with actual stages and duration decomposition
        receipt = {
            "schema": "fullmag.local-runner.build-receipt.v1",
            "state": "succeeded",
            "stages": [
                {"name": "native-build", "exit_code": 0, "duration_ms": 12000, "started_at": "2026-09-13T12:01:00Z"},
                {"name": "frontend-dependencies", "exit_code": 0, "duration_ms": 8500, "started_at": "2026-09-13T12:01:12Z"},
                {"name": "frontend-build", "exit_code": 0, "duration_ms": 15000, "started_at": "2026-09-13T12:01:20Z"},
            ],
            "finished_at": "2026-09-13T12:01:35Z",
        }
        (runs_dir.parent / "build-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        stages_from_receipt = build_job_timeline(job, self.root)
        self.assertEqual("succeeded", stages_from_receipt[2]["status"])
        self.assertEqual(12.0, stages_from_receipt[2]["duration_seconds"])
        self.assertEqual("succeeded", stages_from_receipt[3]["status"])
        self.assertEqual(8.5, stages_from_receipt[3]["duration_seconds"])
        self.assertEqual("succeeded", stages_from_receipt[4]["status"])
        self.assertEqual(15.0, stages_from_receipt[4]["duration_seconds"])
        self.assertEqual("succeeded", stages_from_receipt[5]["status"])  # receipt verification

        # Succeeded terminal job
        job["state"] = "succeeded"
        job["exit_code"] = 0
        stages_succeeded = build_job_timeline(job, self.root)
        for st in stages_succeeded:
            self.assertEqual("succeeded", st["status"])

    def test_pinned_retention_candidate_appears_in_retained(self):
        # Create a dummy run directory with execution
        run_exec = self.root / "runs" / "wt-ret" / "job-pinned" / "execution"
        run_exec.mkdir(parents=True)
        (run_exec / "build.bin").write_bytes(b"X" * 1024)

        # Pin this resource
        self.hub.set_pinned("exec-wt-ret-job-pinned", True, "Manual preservation for test")

        # Mock queue and retention_plan
        class MockQueue:
            def list(self, owner=None, limit=1000):
                return [{"job_id": "job-pinned", "worktree_id": "wt-ret"}]

        # When raw_plan has this job as candidate, but it is pinned:
        with patch("local_runner.observability.retention_plan") as mock_plan:
            mock_plan.return_value = {
                "candidates": [{
                    "worktree_id": "wt-ret",
                    "job_id": "job-pinned",
                    "execution": str(run_exec),
                    "bytes": 1024,
                    "reason": "expired",
                }],
                "retained": [],
            }
            plan = self.hub.generate_retention_plan(queue=MockQueue())
            self.assertEqual(0, plan["candidates_count"])
            self.assertEqual(1, plan["retained_count"])
            self.assertIn("Manual preservation for test", plan["retained"][0]["why_retained"])
            self.assertIn("ochrona przed retencją", plan["retained"][0]["why_retained"])

    def test_storage_resources_completeness_and_error_fields(self):
        res = self.hub.get_storage_resources()
        self.assertIn("completeness", res)
        self.assertIn("had_errors", res)
        self.assertIn(res["completeness"], ("complete", "partial"))
        self.assertIsInstance(res["had_errors"], bool)

    def test_apply_retention_plan_preview_only_safe(self):
        # Create candidate file
        run_exec = self.root / "runs" / "wt-safe" / "job-safe" / "execution"
        run_exec.mkdir(parents=True)
        test_file = run_exec / "artifact.bin"
        test_file.write_bytes(b"A" * 4096)

        class MockQueue:
            def list(self, owner=None, limit=1000):
                return [{"job_id": "job-safe", "worktree_id": "wt-safe"}]

        with patch("local_runner.observability.retention_plan") as mock_plan:
            mock_plan.return_value = {
                "candidates": [{
                    "worktree_id": "wt-safe",
                    "job_id": "job-safe",
                    "execution": str(run_exec),
                    "bytes": 4096,
                    "reason": "expired",
                }],
                "retained": [],
            }
            plan = self.hub.generate_retention_plan(queue=MockQueue())
            self.assertEqual(1, plan["candidates_count"])
            plan_id = plan["plan_id"]

            result = self.hub.apply_retention_plan(plan_id)
            self.assertFalse(result["applied"])
            self.assertEqual("preview_only", result["status"])
            self.assertEqual(0, result["reclaimed_bytes"])
            self.assertEqual("cleanup_executor_not_enabled", result["error"])
            # The file MUST still exist!
            self.assertTrue(test_file.exists())
            self.assertEqual(4096, test_file.stat().st_size)

    def test_record_event_emits_structured_line_to_stdout(self):
        import io
        stdout_buf = io.StringIO()
        with patch("sys.stdout", stdout_buf):
            self.hub.record_event("INFO", "test_lifecycle_event", "Docker log message test with token=secret123", job_id="job-stdout-1", stage="compile")
            output = stdout_buf.getvalue()
            self.assertIn("[INFO]", output)
            self.assertIn("test_lifecycle_event:", output)
            self.assertIn("token=***", output)
            self.assertNotIn("secret123", output)
            self.assertIn("(job=job-stdout-1)", output)
            self.assertIn("(stage=compile)", output)

    def test_unindexed_execution_tree_protected_in_retention_plan(self):
        # Create unindexed execution directory on disk without queue entry
        unindexed_exec = self.root / "runs" / "wt-unindexed" / "job-unindexed" / "execution"
        unindexed_exec.mkdir(parents=True)
        (unindexed_exec / "build.bin").write_bytes(b"Z" * 2048)

        class EmptyQueue:
            def list(self, owner=None, limit=1000):
                return []

        plan = self.hub.generate_retention_plan(queue=EmptyQueue())
        # The unindexed execution directory MUST NOT be a candidate!
        self.assertEqual(0, plan["candidates_count"])
        # It MUST be retained and protected
        retained_ids = [r["resource_id"] for r in plan["retained"]]
        self.assertIn("exec-wt-unindexed-job-unindexed", retained_ids)
        retained_item = next(r for r in plan["retained"] if r["resource_id"] == "exec-wt-unindexed-job-unindexed")
        self.assertIn("ochrona przed usunięciem", retained_item["why_retained"])
        self.assertEqual(2048, retained_item["size_bytes"])

    def test_timeline_progress_from_worker_log(self):
        job = {
            "job_id": "job-worker-log",
            "worktree_id": "wt-log",
            "state": "running",
            "created_at": 1773000000.0,
            "started_at": 1773000002.0,
        }
        runs_dir = self.root / "runs" / "wt-log" / "job-worker-log"
        runs_dir.mkdir(parents=True, exist_ok=True)
        worker_log = (
            "[fullmag runner] stage native-build start command=[\"cargo\", \"build\"]\n"
            "[fullmag runner] stage native-build end exit_code=0 duration_ms=5000.0\n"
            "[fullmag runner] stage frontend-dependencies start command=[\"pnpm\", \"install\"]\n"
        )
        (runs_dir / "worker.log").write_text(worker_log, encoding="utf-8")

        stages = build_job_timeline(job, self.root)
        self.assertEqual("succeeded", stages[0]["status"])  # queued
        self.assertEqual("succeeded", stages[1]["status"])  # prepare
        self.assertEqual("succeeded", stages[2]["status"])  # native-build
        self.assertEqual(0, stages[2]["exit_code"])
        self.assertEqual("running", stages[3]["status"])    # frontend-dependencies
        self.assertEqual("pending", stages[4]["status"])    # frontend-build
        self.assertEqual("pending", stages[5]["status"])    # receipt-verification

    def test_storage_resources_partial_completeness_on_read_error(self):
        runs_dir = self.root / "runs" / "wt-err" / "job-err" / "execution"
        runs_dir.mkdir(parents=True)
        (runs_dir / "file.bin").write_bytes(b"data")

        with patch("local_runner.observability._fast_dir_size", return_value=(100, 1, True)):
            res = self.hub.get_storage_resources()
            self.assertEqual("partial", res["completeness"])
            self.assertTrue(res["had_errors"])


if __name__ == "__main__":
    unittest.main()
