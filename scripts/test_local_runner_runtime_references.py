from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from local_runner.runtime_references import plan_runtime_references


class RuntimeReferencePlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "storage"
        self.root.mkdir()
        (self.root / "runs").mkdir()
        self.jobs = []
        self._add_build("build-a", updated=10)
        self._add_build("build-b", updated=20)
        self._add_build("build-c", updated=30)

    def _add_build(self, job_id, *, updated, worktree="wt", profile="fem-cpu-v1",
                   state="succeeded", operation="build"):
        job = {
            "job_id": job_id,
            "worktree_id": worktree,
            "profile": profile,
            "operation": operation,
            "state": state,
            "source_digest": (job_id.encode().hex() * 32)[:64],
            "created_at": updated - 1,
            "updated_at": updated,
            "exit_code": 0 if state == "succeeded" else None,
            "payload": {},
        }
        self.jobs.append(job)
        run_root = self.root / "runs" / worktree / job_id
        package = run_root / "artifacts" / "outputs" / ".fullmag" / "local"
        package.mkdir(parents=True)
        # A payload file proves package contents are not required for planning.
        (package / "large-runtime-payload.bin").write_bytes(b"fixture")
        if operation == "build" and state == "succeeded":
            artifacts = run_root / "artifacts"
            receipt = {
                "schema": "fullmag.local-runner.build-receipt.v1",
                "job_id": job_id,
                "profile": profile,
                "source_digest": job["source_digest"],
                "image_digest": "sha256:" + "a" * 64,
                "state": "succeeded",
                "qualification": "NOT VERIFIED",
                "artifacts": [{
                    "path": "outputs/.fullmag/local/bin/fullmag-bin",
                    "size": 7,
                    "sha256": "b" * 64,
                }],
            }
            (artifacts / "build-receipt.json").write_text(
                json.dumps(receipt), encoding="utf-8"
            )
        return job

    def _mark_package_removed(self, job_id, *, state):
        job = next(item for item in self.jobs if item["job_id"] == job_id)
        run_root = self.root / "runs" / job["worktree_id"] / job_id
        shutil.rmtree(run_root / "artifacts" / "outputs" / ".fullmag" / "local")
        receipt_path = run_root / "artifacts" / "build-receipt.json"
        tombstone = {
            "schema": "fullmag.runtime-package-retention.v1",
            "state": state,
            "job_id": job_id,
            "worktree_id": job["worktree_id"],
            "source_digest": job["source_digest"],
            "package_relative": "outputs/.fullmag/local",
            "build_receipt_sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
            "plan_id": "plan-12345678",
        }
        self._write_json(run_root / "artifacts" / "runtime-package-retention.json", tombstone)
    def _plan(self, *, jobs=None, containers=(), roots=(), **kwargs):
        defaults = {
            "jobs_complete": True,
            "containers_complete": True,
            "reference_roots_complete": True,
            "min_artifacts_to_keep": 1,
            "current_coordinator_id": None,
        }
        defaults.update(kwargs)
        return plan_runtime_references(
            self.root,
            self.jobs if jobs is None else jobs,
            list(containers),
            list(roots),
            **defaults,
        )

    def _candidate_ids(self, plan):
        return {item["job_id"] for item in plan["candidates"]}

    def _write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def test_minimum_latest_successes_and_self_receipts_are_not_consumers(self):
        plan = self._plan(min_artifacts_to_keep=1)
        self.assertTrue(plan["complete"], plan["errors"])
        self.assertEqual(self._candidate_ids(plan), {"build-a", "build-b"})
        self.assertEqual(plan["status"], "ready")
        candidate = plan["candidates"][0]
        for field in ("package_path", "source_digest", "tree_identity", "reference_fingerprint"):
            self.assertTrue(candidate[field])
        self.assertTrue(candidate["tree_identity"].startswith("sha256:"))
        self.assertTrue(candidate["reference_fingerprint"].startswith("sha256:"))
        retained = {item["job_id"]: item["reason"] for item in plan["retained"]}
        self.assertEqual(retained["build-c"], "minimum_successful_builds")
        self.assertFalse(any(ref["source"].endswith("build-receipt.json")
                             for ref in plan["references"]))

    def test_actual_comsol_ui_and_openapi_metadata_reference_runtime(self):
        request = {
            "schema": "fullmag.comsol-dispersion-benchmark.request.v1",
            "job": {"job_id": "build-c", "worktree_id": "wt"},
            "runtime": {
                "artifact_root": "build-run/artifacts/outputs/.fullmag/local",
                "image_digest": "sha256:" + "a" * 64,
            },
            "ui": {"frontend": {"job_id": "build-a"}},
        }
        self._write_json(
            self.root / "runs" / "wt" / "build-c" / "comsol-dispersion" /
            "run-1" / "run-request.json",
            request,
        )
        self._write_json(
            self.root / "runs" / "wt" / "ui-model-previews" / "preview-1" / "receipt.json",
            {
                "schema": "fullmag.de-ui-model-preview.v1",
                "runtime_job_id": "build-b",
                "frontend": {"job_id": "build-a"},
                "container_id": "c" * 64,
            },
        )
        self._write_json(
            self.root / "runs" / "wt" / "openapi-export" / "export-1" / "receipt.json",
            {
                "schema": "fullmag.managed-package-openapi.v1",
                "job_id": "build-c",
                "state": "succeeded",
            },
        )
        plan = self._plan()
        self.assertTrue(plan["complete"], plan["errors"])
        self.assertEqual(self._candidate_ids(plan), set())
        refs = {(ref["job_id"], ref["kind"]) for ref in plan["references"]}
        self.assertIn(("build-c", "job.job_id"), refs)
        self.assertIn(("build-b", "runtime_job_id"), refs)
        self.assertIn(("build-a", "frontend.job_id"), refs)
        self.assertIn(("build-c", "job_id"), refs)

    def test_active_queue_reference_and_stopped_parent_mount_protect_package(self):
        self._add_build("build-d", updated=40)
        active = {
            "job_id": "queued-consumer",
            "worktree_id": "wt",
            "profile": "fem-cpu-v1",
            "operation": "build",
            "state": "queued",
            "source_digest": "c" * 64,
            "payload": {"runtime_job_id": "build-a"},
        }
        container = {
            "Id": "d" * 64,
            "State": {"Status": "exited"},
            "Config": {"Labels": {}},
            "Mounts": [{
                "Type": "bind",
                "Source": str(self.root / "runs" / "wt" / "build-b" / "artifacts"),
                "Destination": "/runtime-parent",
            }],
        }
        plan = self._plan(jobs=self.jobs + [active], containers=[container])
        self.assertTrue(plan["complete"], plan["errors"])
        self.assertEqual(self._candidate_ids(plan), {"build-c"})
        retained = {item["job_id"]: item["reason"] for item in plan["retained"]}
        self.assertIn("active_reference", retained["build-a"])
        self.assertIn("container_mount", retained["build-b"])

    def test_current_coordinator_is_excluded_only_with_exact_id_and_labels(self):
        coordinator_id = "e" * 64
        container = {
            "Id": coordinator_id,
            "State": {"Status": "running"},
            "Config": {"Labels": {
                "com.fullmag.local-runner": "build-coordinator",
                "com.fullmag.local-runner.role": "coordinator",
                "com.fullmag.local-runner.schema": "fullmag.local-runner.container.v1",
            }},
            "Mounts": [{
                "Type": "bind",
                "Source": str(self.root),
                "Destination": "/storage",
            }],
        }
        excluded = self._plan(
            containers=[container], current_coordinator_id=coordinator_id
        )
        self.assertTrue(excluded["complete"], excluded["errors"])
        self.assertEqual(self._candidate_ids(excluded), {"build-a", "build-b"})

        bad_labels = dict(container)
        bad_labels["Config"] = {"Labels": {"com.fullmag.local-runner.role": "coordinator"}}
        mismatched = self._plan(containers=[bad_labels], current_coordinator_id=coordinator_id)
        self.assertEqual(self._candidate_ids(mismatched), set())

        not_excluded = self._plan(containers=[container])
        self.assertTrue(not_excluded["complete"], not_excluded["errors"])
        self.assertEqual(self._candidate_ids(not_excluded), set())

    def test_artifact_job_and_run_pins_protect_candidate(self):
        for resource_id in ("art-wt-build-a", "build-a", "exec-wt-build-a", "run-wt-build-a"):
            with self.subTest(resource_id=resource_id):
                pin_path = self.root / "index" / "pinned-resources.json"
                pin_path.parent.mkdir(exist_ok=True)
                pin_path.write_text(json.dumps({
                    resource_id: {"pinned": True, "reason": "test"}
                }), encoding="utf-8")
                plan = self._plan()
                self.assertIn("build-a", {
                    item["job_id"] for item in plan["retained"]
                })
                self.assertNotIn("build-a", self._candidate_ids(plan))
                pin_path.unlink()

    def test_run_and_build_receipt_pins_protect_candidate(self):
        run_receipt = self.root / "runs" / "wt" / "build-a" / "receipt.json"
        build_receipt = self.root / "runs" / "wt" / "build-a" / "artifacts" / "build-receipt.json"
        other_receipts = (
            self.root / "runs" / "wt" / "build-a" / "artifacts" / "receipt.json",
            self.root / "runs" / "wt" / "build-a" / "execution" / "build-receipt.json",
        )
        for path in (run_receipt, build_receipt, *other_receipts):
            with self.subTest(path=path.name, parent=path.parent.name):
                if path == build_receipt:
                    receipt = json.loads(path.read_text(encoding="utf-8"))
                    receipt["pinned"] = True
                else:
                    receipt = {"schema": "fullmag.local-runner.coordinator.v1", "pinned": True}
                self._write_json(path, receipt)
                plan = self._plan()
                self.assertTrue(plan["complete"], plan["errors"])
                self.assertNotIn("build-a", self._candidate_ids(plan))
                retained = {item["job_id"]: item["reason"] for item in plan["retained"]}
                self.assertIn("receipt_pin:", retained["build-a"])
                if path == build_receipt:
                    receipt.pop("pinned")
                    self._write_json(path, receipt)
                else:
                    path.unlink()

    def test_corrupt_consumer_document_blocks_unknown_cross_job_scope(self):
        bad = self.root / "runs" / "wt" / "build-b" / "comsol-dispersion" / "run-1" / "run-result.json"
        bad.parent.mkdir(parents=True)
        bad.write_text("{broken", encoding="utf-8")
        plan = self._plan()
        self.assertFalse(plan["complete"])
        self.assertTrue(plan["unknown_scope"])
        self.assertEqual(self._candidate_ids(plan), set())
        self.assertTrue(any(error["scope"] == "global" for error in plan["errors"]))

    def test_custom_scientific_batch_and_managed_browser_receipt_reference_runtime(self):
        self._write_json(
            self.root / "runs" / "wt" / "scientific-batches" / "batch-1" / "run-request.json",
            {
                "schema": "fullmag.de-smoke.request.v1",
                "job": {"job_id": "build-c", "worktree_id": "wt"},
                "runtime": {"runtime_job_id": "build-a"},
                "ui": {"frontend": {"job_id": "build-b"}},
            },
        )
        self._write_json(
            self.root / "builds" / "wt" / "managed-browser-cpu" /
            "runs" / "browser-1" / "receipt.json",
            {
                "schema": "fullmag.managed-browser.v1",
                "managed_job_id": "build-a",
                "state": "running",
            },
        )
        plan = self._plan()
        self.assertTrue(plan["complete"], plan["errors"])
        self.assertEqual(self._candidate_ids(plan), set())
        refs = {(ref["job_id"], ref["kind"]) for ref in plan["references"]}
        self.assertIn(("build-a", "runtime_job_id"), refs)
        self.assertIn(("build-a", "managed_job_id"), refs)
        self.assertIn(("build-b", "frontend.job_id"), refs)
        self.assertIn(("build-c", "job.job_id"), refs)

    def test_unknown_external_reference_blocks_all_candidates(self):
        root = Path(self.temp.name) / "legacy-receipts"
        self._write_json(root / "artifacts" / "legacy" / "scientific-result.json", {
            "schema": "legacy.scientific-result.v1",
            "runtime_source_job": "not-in-queue",
        })
        plan = self._plan(roots=[root])
        self.assertFalse(plan["complete"])
        self.assertTrue(plan["unknown_scope"])
        self.assertEqual(self._candidate_ids(plan), set())

    def test_corrupt_manual_root_document_blocks_all_candidates(self):
        root = Path(self.temp.name) / "legacy-receipts"
        root.mkdir()
        (root / "receipt.json").write_text("{broken", encoding="utf-8")
        plan = self._plan(roots=[root])
        self.assertFalse(plan["complete"])
        self.assertTrue(plan["unknown_scope"])
        self.assertEqual(self._candidate_ids(plan), set())

    def test_incomplete_inventory_and_unsafe_artifact_root_fail_closed(self):
        incomplete = self._plan(jobs_complete=False)
        self.assertEqual(self._candidate_ids(incomplete), set())
        self.assertTrue(incomplete["unknown_scope"])

        for flag in ("containers_complete", "reference_roots_complete"):
            partial = self._plan(**{flag: False})
            self.assertEqual(self._candidate_ids(partial), set())
            self.assertTrue(partial["unknown_scope"])

        root = Path(self.temp.name) / "legacy-receipts"
        self._write_json(root / "bad-root.json", {
            "schema": "legacy.result.v1",
            "job_id": "build-a",
            "runtime": {"artifact_root": "../../outside"},
        })
        unsafe = self._plan(roots=[root])
        self.assertEqual(self._candidate_ids(unsafe), set())
        self.assertTrue(unsafe["unknown_scope"])

    def test_replacement_metadata_is_read_on_each_plan(self):
        root = Path(self.temp.name) / "legacy-receipts"
        receipt = root / "result.json"
        self._write_json(receipt, {"runtime_job_id": "build-a"})
        first = self._plan(roots=[root])
        self.assertNotIn("build-a", self._candidate_ids(first))
        self._write_json(receipt, {"runtime_job_id": "build-b"})
        second = self._plan(roots=[root])
        self.assertIn("build-a", self._candidate_ids(second))
        self.assertNotIn("build-b", self._candidate_ids(second))

    def test_removed_tombstone_requires_exact_receipt_identity_and_state(self):
        self._mark_package_removed("build-a", state="removed")
        artifacts_root = self.root / "runs" / "wt" / "build-a" / "artifacts"
        first = self._plan(roots=[artifacts_root])
        self.assertTrue(first["complete"], first["errors"])
        self.assertEqual(self._candidate_ids(first), {"build-b"})
        retained = {item["job_id"]: item["reason"] for item in first["retained"]}
        self.assertEqual(retained["build-a"], "intentionally_removed")
        self.assertFalse(any("runtime-package-retention.json" in ref["source"]
                             for ref in first["references"]))

        self._mark_package_removed("build-b", state="partial_error")
        second = self._plan()
        self.assertFalse(second["complete"])
        self.assertFalse(second["unknown_scope"])
        self.assertNotIn("build-b", self._candidate_ids(second))
        self.assertTrue(any(error["scope"] == "job:build-b" for error in second["errors"]))

    def test_unsupported_fullmag_reference_schema_blocks_all_candidates(self):
        root = Path(self.temp.name) / "legacy-receipts"
        self._write_json(root / "consumer.json", {
            "schema": "fullmag.future-runtime-consumer.v9",
            "runtime_job_id": "build-a",
        })
        plan = self._plan(roots=[root])
        self.assertFalse(plan["complete"])
        self.assertTrue(plan["unknown_scope"])
        self.assertEqual(self._candidate_ids(plan), set())
        self.assertTrue(any(error["code"] == "unsupported_reference_schema:fullmag.future-runtime-consumer.v9"
                            for error in plan["errors"]))
    def test_orphan_package_and_malformed_container_are_unknown(self):
        orphan = self.root / "runs" / "other-wt" / "orphan" / "artifacts" / "outputs" / ".fullmag" / "local"
        orphan.mkdir(parents=True)
        plan = self._plan()
        self.assertFalse(plan["complete"])
        self.assertTrue(plan["unknown_scope"])
        self.assertEqual(self._candidate_ids(plan), set())

        malformed = self._plan(containers=[{"Id": "short", "Mounts": []}])
        self.assertTrue(malformed["unknown_scope"])
        self.assertEqual(self._candidate_ids(malformed), set())


if __name__ == "__main__":
    unittest.main()
