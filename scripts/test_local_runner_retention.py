import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from local_runner.retention import RetentionError, plan  # noqa: E402


class RetentionPlanTests(unittest.TestCase):
    now = 2_000_000.0
    source_digest = "b" * 64
    container_id = "a" * 64

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.storage = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def _job(self, job_id="job-1", worktree_id="wt-1", state="succeeded", finished_at=None,
             owner="operator", source_digest=None):
        return {
            "job_id": job_id,
            "owner": owner,
            "worktree_id": worktree_id,
            "source_digest": source_digest or self.source_digest,
            "profile": "fem-cpu-release",
            "operation": "build",
            "payload": {},
            "state": state,
            "created_at": self.now - 100,
            "updated_at": finished_at if finished_at is not None else self.now - 25 * 3600,
        }

    def _materialize(self, job, *, journal_overrides=None, execution_files=None):
        run_root = self.storage / "runs" / job["worktree_id"] / job["job_id"]
        execution = run_root / "execution"
        execution.mkdir(parents=True)
        for name, content in (execution_files or {"result.bin": b"12345"}).items():
            target = execution / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        journal = {
            "schema": "fullmag.local-runner.coordinator.v1",
            "job_id": job["job_id"],
            "owner": job["owner"],
            "source_digest": job["source_digest"],
            "container_id": self.container_id,
            "state": job["state"],
            "finished_at": job["updated_at"],
        }
        journal.update(journal_overrides or {})
        (run_root / "coordinator.json").write_text(json.dumps(journal), encoding="utf-8")
        return run_root, execution

    def test_expired_success_counts_only_execution(self):
        job = self._job()
        run_root, execution = self._materialize(job, execution_files={"nested/out.bin": b"12345"})
        (run_root / "artifacts").mkdir()
        (run_root / "artifacts" / "large.log").write_bytes(b"x" * 101)
        (run_root / "worker.log").write_bytes(b"y" * 103)
        (self.storage / "cache").mkdir()
        (self.storage / "cache" / "shared.bin").write_bytes(b"z" * 107)

        result = plan(self.storage, [job], self.now)

        self.assertEqual([], result["retained"])
        self.assertEqual(1, len(result["candidates"]))
        candidate = result["candidates"][0]
        self.assertEqual(str(execution.resolve()), candidate["execution"])
        self.assertEqual(self.container_id, candidate["container_id"])
        self.assertEqual("succeeded_expired", candidate["reason"])
        self.assertEqual(5, candidate["bytes"])
        self.assertEqual(5, result["space"]["candidate_bytes"])
        self.assertEqual(0, result["space"]["retained_bytes"])
        self.assertTrue((run_root / "artifacts" / "large.log").exists())

    def test_failed_and_cancelled_use_longer_window(self):
        failed = self._job("job-failed", state="failed", finished_at=self.now - 200 * 3600)
        cancelled = self._job("job-cancelled", state="cancelled", finished_at=self.now - 200 * 3600)
        self._materialize(failed)
        self._materialize(cancelled)

        result = plan(self.storage, [failed, cancelled], self.now)

        self.assertEqual({"failed_expired", "cancelled_expired"},
                         {item["reason"] for item in result["candidates"]})

    def test_active_and_not_expired_jobs_are_retained_without_path_access(self):
        running = self._job("running", state="running")
        cancelling = self._job("cancelling", state="cancel_requested")
        fresh = self._job("fresh", finished_at=self.now - 2 * 3600)
        self._materialize(fresh)

        result = plan(self.storage, [running, cancelling, fresh], self.now)

        self.assertEqual([], result["candidates"])
        by_id = {item["job_id"]: item for item in result["retained"]}
        self.assertEqual("active", by_id["running"]["reason"])
        self.assertEqual("active", by_id["cancelling"]["reason"])
        self.assertEqual("not_expired", by_id["fresh"]["reason"])

    def test_pin_file_and_pinned_receipt_protect_runs(self):
        marker_job = self._job("marker")
        receipt_job = self._job("receipt")
        marker_root, _ = self._materialize(marker_job)
        receipt_root, _ = self._materialize(receipt_job)
        (marker_root / "artifacts.pin").write_text("operator pin\n", encoding="utf-8")
        artifacts = receipt_root / "artifacts"
        artifacts.mkdir()
        (artifacts / "build-receipt.json").write_text('{"pinned": true}', encoding="utf-8")

        result = plan(self.storage, [marker_job, receipt_job], self.now)

        self.assertEqual([], result["candidates"])
        self.assertEqual({"marker", "receipt"}, {item["job_id"] for item in result["retained"]})
        self.assertTrue(all(item["reason"] == "pinned" for item in result["retained"]))

    def test_coordinator_identity_and_full_container_id_are_required(self):
        owner_mismatch = self._job("owner-mismatch")
        source_mismatch = self._job("source-mismatch")
        missing_container = self._job("missing-container")
        self._materialize(owner_mismatch, journal_overrides={"owner": "other"})
        self._materialize(source_mismatch, journal_overrides={"source_digest": "c" * 64})
        self._materialize(missing_container, journal_overrides={"container_id": "short"})

        result = plan(self.storage, [owner_mismatch, source_mismatch, missing_container], self.now)

        by_id = {item["job_id"]: item for item in result["retained"]}
        self.assertEqual("owner_mismatch", by_id["owner-mismatch"]["reason"])
        self.assertEqual("source_identity_mismatch", by_id["source-mismatch"]["reason"])
        self.assertEqual("missing_full_container_id", by_id["missing-container"]["reason"])
        self.assertEqual([], result["candidates"])

    def test_missing_and_unsupported_runs_are_retained(self):
        missing = self._job("missing")
        unsupported = self._job("blocked", state="blocked")
        malformed = self._job("malformed")
        malformed_root, _ = self._materialize(malformed)
        (malformed_root / "coordinator.json").write_text("not json", encoding="utf-8")

        result = plan(self.storage, [missing, unsupported, malformed], self.now)

        by_id = {item["job_id"]: item for item in result["retained"]}
        self.assertEqual("missing_run_path", by_id["missing"]["reason"])
        self.assertEqual("unsupported_state", by_id["blocked"]["reason"])
        self.assertEqual("invalid_metadata", by_id["malformed"]["reason"])

    def test_symlink_in_execution_is_not_followed(self):
        job = self._job("linked")
        _, execution = self._materialize(job)
        outside = self.storage / "outside.bin"
        outside.write_bytes(b"outside bytes")
        try:
            (execution / "outside-link").symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable on this host")

        result = plan(self.storage, [job], self.now)

        self.assertEqual([], result["candidates"])
        self.assertEqual("unsafe_execution_tree", result["retained"][0]["reason"])
        self.assertEqual(0, result["space"]["candidate_bytes"])

    def test_reparse_run_component_is_not_accepted(self):
        job = self._job("redirected")
        actual = self.storage / "actual" / job["job_id"]
        (actual / "execution").mkdir(parents=True)
        (actual / "coordinator.json").write_text("{}", encoding="utf-8")
        runs = self.storage / "runs"
        runs.mkdir()
        try:
            (runs / job["worktree_id"]).symlink_to(actual.parent, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable on this host")

        result = plan(self.storage, [job], self.now)

        self.assertEqual([], result["candidates"])
        self.assertEqual("unsafe_reparse_path", result["retained"][0]["reason"])

    def test_duplicate_and_invalid_identifiers_do_not_alias_paths(self):
        first = self._job("same")
        duplicate = self._job("same")
        invalid = self._job("../escape")
        self._materialize(first)

        result = plan(self.storage, [duplicate, first, invalid], self.now)

        reasons = {(item["job_id"], item["reason"]) for item in result["retained"]}
        self.assertIn(("same", "duplicate_job"), reasons)
        self.assertIn(("../escape", "invalid_job_identity"), reasons)
        self.assertEqual(1, len(result["candidates"]))

    def test_invalid_policy_is_rejected_without_mutation(self):
        before = sorted(path.relative_to(self.storage).as_posix() for path in self.storage.rglob("*"))
        with self.assertRaises(RetentionError):
            plan(self.storage, [], self.now, success_hours=-1)
        after = sorted(path.relative_to(self.storage).as_posix() for path in self.storage.rglob("*"))
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
