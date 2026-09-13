"""Unit tests for local_runner.observability telemetry and storage inventory."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import time
import unittest

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
        self.assertGreaterEqual(new_sample["disk_free_gb"], 0)

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

        # Initially execution tree is eligible for retention and unpinned
        self.assertFalse(res_map[exec_res_id]["pinned"])
        self.assertTrue(res_map[exec_res_id]["eligible_for_retention"])

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
        self.assertTrue(res_map_unpinned[exec_res_id]["eligible_for_retention"])

    def test_retention_plan_generation_and_safe_apply(self):
        plan = self.hub.generate_retention_plan()
        self.assertIn("plan_id", plan)
        self.assertEqual("preview", plan["status"])
        self.assertIn("candidates", plan)
        self.assertIn("retained", plan)

        apply_res = self.hub.apply_retention_plan(plan["plan_id"])
        self.assertTrue(apply_res["applied"])
        self.assertEqual(plan["plan_id"], apply_res["plan_id"])

        # Nonexistent plan returns applied=False
        err_res = self.hub.apply_retention_plan("nonexistent-plan")
        self.assertFalse(err_res["applied"])

    def test_retention_policy_crud(self):
        default_policy = self.hub.get_retention_policy()
        self.assertEqual("preview", default_policy["mode"])
        self.assertEqual(24, default_policy["ttl_success_hours"])

        updated = self.hub.set_retention_policy({"mode": "automatic", "ttl_success_hours": 48})
        self.assertEqual("automatic", updated["mode"])
        self.assertEqual(48, updated["ttl_success_hours"])

        # Re-fetch confirms persistence on disk
        persisted = self.hub.get_retention_policy()
        self.assertEqual("automatic", persisted["mode"])
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

        # Now simulate log files on disk
        runs_dir = self.root / "runs" / "wt-1" / "job-timeline-test" / "artifacts" / "logs"
        runs_dir.mkdir(parents=True)
        (runs_dir / "native-build.stdout.log").write_text("Finished compilation\n", encoding="utf-8")
        (runs_dir / "frontend-dependencies.stdout.log").write_text("Packages installed\n", encoding="utf-8")

        stages_advanced = build_job_timeline(job, self.root)
        self.assertEqual("succeeded", stages_advanced[2]["status"])  # native-build succeeded
        self.assertEqual("succeeded", stages_advanced[3]["status"])  # frontend-dependencies succeeded
        self.assertEqual("running", stages_advanced[4]["status"])    # frontend-build running

        # Succeeded terminal job
        job["state"] = "succeeded"
        job["exit_code"] = 0
        stages_succeeded = build_job_timeline(job, self.root)
        for st in stages_succeeded:
            self.assertEqual("succeeded", st["status"])


if __name__ == "__main__":
    unittest.main()
