"""Contract checks for the managed COMSOL benchmark runner."""

from __future__ import annotations

import json
from pathlib import Path
import sqlite3
from types import SimpleNamespace
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_comsol_dispersion_benchmark as benchmark


class ComsolDispersionBenchmarkTests(unittest.TestCase):
    def fake_context(self, root: Path) -> benchmark.BuildContext:
        source = root / "capsule" / "tree"
        runtime = root / "build" / "artifacts" / "outputs" / ".fullmag" / "local"
        run_root = root / "build"
        job = {
            "job_id": "a" * 32,
            "worktree_id": "worktree-a",
            "profile": benchmark.PROFILE,
            "source_digest": "b" * 64,
            "payload": {"capsule_relative": "runs/worktree-a/" + "c" * 32 + "/source"},
        }
        native = {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": "d" * 40,
            "source_snapshot_sha256": "e" * 64,
        }
        layout = {"storage_root": str(root), "repo_root": str(root / "repo"), "env": {}}
        return benchmark.BuildContext(
            layout=layout,
            job=job,
            manifest={"resolved_commit": native["head_commit_full"]},
            native_identity=native,
            receipt={"artifact_hashes": {}},
            run_root=run_root,
            artifacts=run_root / "artifacts",
            capsule=source.parent,
            source_tree=source,
            runtime_root=runtime,
        )

    def test_compose_plan_is_pinned_cpu_slepc_and_has_no_build_or_default_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            command = benchmark._compose_command(context, root / "output", benchmark.CASES)
            self.assertEqual(command[:4], ["docker", "compose", "--profile", "fem-modal-cpu"])
            self.assertIn("--no-deps", command)
            self.assertIn("--pull", command)
            self.assertIn("never", command)
            rendered = " ".join(command)
            self.assertIn(benchmark.EXPECTED_IMAGE_DIGEST, rendered)
            self.assertNotIn("fullmag/fem-gpu:local", rendered)
            self.assertNotIn("cmake", rendered)
            self.assertNotIn("cargo", rendered)
            self.assertNotIn("--gpus", rendered)
            self.assertIn(f"{context.source_tree}:/workspace/capsule:ro", command)
            self.assertIn(f"{context.runtime_root}:/workspace/.fullmag/local:ro", command)
            self.assertIn(f"{root / 'output'}:/workspace/benchmark-output:rw", command)
            self.assertIn("--backend fem --mode strict --precision double", rendered)
            self.assertIn("FULLMAG_FEM_EXECUTION=cpu", rendered)
            self.assertIn("FULLMAG_FEM_MFEM_DEVICE=cpu", rendered)
            self.assertIn("FULLMAG_FEM_WITH_SLEPC=ON", rendered)
            self.assertIn("FULLMAG_DISABLE_PREVIEW_3D=1", rendered)
            self.assertIn("FULLMAG_DISABLE_CHARTS=1", rendered)

    def test_case_shell_is_allow_listed_and_runs_each_case_once(self):
        script = benchmark._shell_case_command(("c0", "a1"))
        self.assertEqual(script.count("FULLMAG_COMSOL_DISPERSION_CASE="), 2)
        self.assertIn("case_dir=/workspace/benchmark-output/c0", script)
        self.assertIn("case_dir=/workspace/benchmark-output/a1", script)
        self.assertIn("--headless --json --output-dir", script)
        self.assertNotIn("docker", script)
        self.assertNotIn("cmake", script)
        self.assertNotIn("cargo", script)
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark._shell_case_command(("c0", "unknown"))

    def test_image_check_requires_exact_id_and_does_not_accept_tag(self):
        image = "sha256:" + "a" * 64
        called = Mock(
            return_value=SimpleNamespace(
                returncode=0,
                stdout=json.dumps([{"Id": image, "Config": {}}]),
            )
        )
        result = benchmark._inspect_image(image, run=called)
        self.assertEqual(result["id"], image)
        called.assert_called_once()
        with self.assertRaises(benchmark.BenchmarkError):
            benchmark._inspect_image("fullmag/fem-gpu:local", run=called)

    def test_case_artifacts_require_json_csv_mode_and_potential_payloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for case in ("c0", "c1"):
                case_dir = root / case
                for relative in benchmark.REQUIRED_CASE_ARTIFACTS:
                    path = case_dir / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if relative == "eigen/spectrum.v2.json":
                        path.write_text(json.dumps({"schema_version": "eigen_spectrum.v2"}), encoding="utf-8")
                    elif relative == "eigen/branches.v2.json":
                        path.write_text(json.dumps({"schema_version": "eigen_branches.v2"}), encoding="utf-8")
                    elif relative == "eigen/dispersion.csv":
                        path.write_text("kx_rad_per_m,ky_rad_per_m,frequency_hz\n0,0,1\n", encoding="utf-8")
                    else:
                        path.write_text("{}", encoding="utf-8")
                mode = case_dir / "eigen/mode_fields/sample_0000/mode_0000/vector.bin"
                mode.parent.mkdir(parents=True, exist_ok=True)
                mode.write_bytes(b"mode")
                if case == "c1":
                    potential = mode.parent / "potential_full.bin"
                    potential.write_bytes(b"potential")
                    (mode.parent / "physical_potential.v1.json").write_text("{}", encoding="utf-8")
                result = benchmark._validate_case_artifacts(case_dir, case)
                self.assertEqual(result["dispersion_rows"], 1)
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._validate_case_artifacts(root / "c0", "c1")

    def test_new_output_is_inside_storage_and_existing_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            candidate = benchmark._new_output_dir(context, None)
            self.assertIn(root, candidate.parents)
            candidate.mkdir(parents=True)
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._new_output_dir(context, str(candidate))

    def test_dry_run_does_not_contact_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            layout = {
                "storage_root": str(root),
                "repo_root": str(root / "repo"),
                "worktree_id": "worktree-a",
                "env": {},
            }
            with patch.object(benchmark.fullmag_storage, "resolve_layout", return_value=layout), \
                 patch.object(benchmark, "_read_job", return_value=context.job), \
                 patch.object(benchmark, "_validate_build_context", return_value=context), \
                 patch.object(benchmark, "_compose_command", return_value=["docker", "compose"]), \
                 patch.object(benchmark, "_inspect_image", side_effect=AssertionError("Docker must not be inspected")):
                self.assertEqual(benchmark.main(["--job-id", context.job["job_id"], "--dry-run"]), 0)

    def test_job_reader_requires_succeeded_modal_build_and_canonical_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            repo.mkdir()
            (root / "index").mkdir()
            job_id = "a" * 32
            capture_id = "c" * 32
            payload = {
                "origin_repo": str(repo),
                "capture_id": capture_id,
                "capsule_relative": f"runs/worktree-a/{capture_id}/source",
                "native_source_identity": {
                    "schema": "fullmag.source-snapshot.v2",
                    "head_commit_full": "d" * 40,
                    "source_snapshot_sha256": "e" * 64,
                },
            }
            connection = sqlite3.connect(root / "index/runner-jobs.sqlite")
            with connection:
                connection.execute(
                    """
                    CREATE TABLE jobs (
                        job_id TEXT, owner TEXT, worktree_id TEXT,
                        source_digest TEXT, profile TEXT, operation TEXT,
                        payload TEXT, state TEXT, exit_code INTEGER
                    )
                    """
                )
                connection.execute(
                    "INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        job_id,
                        "operator",
                        "worktree-a",
                        "b" * 64,
                        benchmark.PROFILE,
                        "build",
                        json.dumps(payload),
                        "succeeded",
                        0,
                    ),
                )
            connection.close()
            layout = {
                "storage_root": str(root),
                "repo_root": str(repo),
                "worktree_id": "worktree-a",
            }
            job = benchmark._read_job(layout, job_id)
            self.assertEqual(job["profile"], benchmark.PROFILE)
            self.assertEqual(job["payload"]["capture_id"], capture_id)
            connection = sqlite3.connect(root / "index/runner-jobs.sqlite")
            with connection:
                connection.execute("UPDATE jobs SET state='failed'")
            connection.close()
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._read_job(layout, job_id)


if __name__ == "__main__":
    unittest.main()
