"""Contract checks for the managed COMSOL benchmark runner."""

from __future__ import annotations

import json
import ntpath
from pathlib import Path
import sqlite3
import subprocess
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
            self.assertEqual(command[:2], ["docker", "compose"])
            self.assertEqual(command[2], "-f")
            self.assertEqual(command[4], "-f")
            profile_index = command.index("--profile")
            self.assertEqual(command[profile_index : profile_index + 2], ["--profile", "fem-modal-cpu"])
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
            identity = benchmark._container_identity(context, root / "output")
            self.assertIn("--name", command)
            self.assertEqual(command[command.index("--name") + 1], identity["name"])
            labels = {
                command[index + 1].split("=", 1)[0]: command[index + 1].split("=", 1)[1]
                for index, token in enumerate(command[:-1])
                if token == "--label"
            }
            self.assertEqual(labels, identity["labels"])
            self.assertIn("timeout", command)
            timeout_index = command.index("timeout")
            self.assertEqual(
                command[timeout_index : timeout_index + 6],
                [
                    "timeout",
                    "--foreground",
                    "--signal=TERM",
                    "--kill-after=30s",
                    "21600",
                    "bash",
                ],
            )
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

    def test_external_scientific_evidence_is_staged_and_hash_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "output" / "c0"
            case_dir.mkdir(parents=True)
            source_case = root / "evidence" / "c0"
            source_validation = source_case / "validation"
            source_validation.mkdir(parents=True)
            bindings = {
                "metadata_sha256": "a" * 64,
                "spectrum_v2_sha256": "b" * 64,
                "branches_v2_sha256": "c" * 64,
                "dispersion_csv_sha256": "d" * 64,
                "manifest_sha256": "e" * 64,
                "solver_diagnostics_sha256": "f" * 64,
            }
            evidence = {
                "schema_version": benchmark.EVIDENCE_SCHEMA,
                "case_id": "c0",
                "numeric_run": {
                    "frequency_source": "native_solver_attested",
                    "analytic_solver_used_for_frequencies": False,
                    "dynamic_demag_operator_source": None,
                },
                "artifact_bindings": bindings,
                "analytic_controls": {"kittel": {"status": "pass"}},
                "convergence": {
                    "mesh": {"status": "pass"},
                    "airbox": {"status": "not_applicable"},
                    "mode_count": {"status": "pass"},
                },
            }
            (source_validation / "scientific_gate.v1.json").write_text(
                json.dumps(evidence), encoding="utf-8"
            )
            comparison = source_case / "validation" / "comparison" / "mesh.json"
            comparison.parent.mkdir(parents=True)
            comparison.write_text("{}", encoding="utf-8")
            staged = benchmark._stage_external_scientific_evidence(
                case_dir, "c0", root / "evidence", bindings
            )
            self.assertEqual(staged["case_id"], "c0")
            self.assertEqual(staged["evidence_provenance"]["copied_file_count"], 1)
            self.assertEqual(
                (case_dir / "validation" / "comparison" / "mesh.json").read_text(), "{}"
            )

    def test_external_scientific_evidence_rejects_stale_primary_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            case_dir = root / "output" / "c0"
            case_dir.mkdir(parents=True)
            source_case = root / "evidence" / "c0" / "validation"
            source_case.mkdir(parents=True)
            evidence = {
                "schema_version": benchmark.EVIDENCE_SCHEMA,
                "case_id": "c0",
                "numeric_run": {},
                "artifact_bindings": {"metadata_sha256": "0" * 64},
                "analytic_controls": {},
                "convergence": {},
            }
            (source_case / "scientific_gate.v1.json").write_text(
                json.dumps(evidence), encoding="utf-8"
            )
            with self.assertRaisesRegex(benchmark.BenchmarkError, "binding"):
                benchmark._stage_external_scientific_evidence(
                    case_dir,
                    "c0",
                    root / "evidence",
                    {"metadata_sha256": "1" * 64},
                )

    def test_new_output_is_inside_storage_and_existing_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            candidate = benchmark._new_output_dir(context, None)
            self.assertIn(root, candidate.parents)
            candidate.mkdir(parents=True)
            with self.assertRaises(benchmark.BenchmarkError):
                benchmark._new_output_dir(context, str(candidate))

    def _owned_container_payload(self, context, output_dir, *, running=True, labels=None):
        identity = benchmark._container_identity(context, output_dir)
        mounts = [
            {
                "Source": mount["source"],
                "Destination": mount["destination"],
                "RW": not mount["read_only"],
            }
            for mount in benchmark._expected_container_mounts(context, output_dir)
        ]
        return {
            "Id": "a" * 64,
            "Name": "/" + identity["name"],
            "Image": benchmark.EXPECTED_IMAGE_DIGEST,
            "Config": {
                "Image": benchmark.EXPECTED_IMAGE_DIGEST,
                "Labels": dict(labels or identity["labels"]),
            },
            "Mounts": mounts,
            "State": {"Running": running, "Status": "running" if running else "exited"},
        }

    def test_windows_mount_projection_preserves_forward_slashes(self):
        expected = r"C:\git\fullmag\storage\runs\benchmark"
        projected = "/host_mnt/c/git/fullmag/storage/runs/benchmark"
        with patch.object(benchmark.os, "name", "nt"), patch.object(
            benchmark.os, "path", ntpath
        ):
            # This is the Windows behavior that caused the regression: the
            # real ntpath.normcase() turns the canonical slash form back into
            # backslashes, so the helper must apply case folding separately.
            self.assertEqual(ntpath.normcase("C:/git/fullmag/storage/runs/benchmark"), expected.lower())
            self.assertEqual(
                benchmark._normalized_mount_source(expected),
                "c:/git/fullmag/storage/runs/benchmark",
            )
            self.assertTrue(benchmark._mount_source_matches(projected, expected))
            self.assertTrue(benchmark._mount_source_matches(expected, expected))

    def test_cleanup_requires_exact_identity_and_removes_only_owned_container(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            payload = self._owned_container_payload(context, output_dir, running=True)
            calls = []
            inspect_count = 0

            def docker_run(argv, **kwargs):
                nonlocal inspect_count
                calls.append(argv)
                if argv[:4] == ["docker", "container", "inspect", argv[3]]:
                    inspect_count += 1
                    if inspect_count == 1:
                        current = payload
                    elif inspect_count == 2:
                        current = {**payload, "State": {"Running": False, "Status": "exited"}}
                    else:
                        return SimpleNamespace(returncode=1, stdout="", stderr="No such container")
                    return SimpleNamespace(returncode=0, stdout=json.dumps([current]), stderr="")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            result = benchmark._cleanup_benchmark_container(context, output_dir, run=docker_run)
            self.assertEqual(result["status"], "removed")
            self.assertIn(["docker", "container", "stop", "--time", "10", "a" * 64], calls)
            self.assertIn(["docker", "container", "rm", "a" * 64], calls)

    def test_cleanup_blocks_on_foreign_labels_without_stop_or_remove(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            output_dir.mkdir()
            identity = benchmark._container_identity(context, output_dir)
            foreign = dict(identity["labels"])
            foreign[benchmark.CONTAINER_LABEL_JOB] = "foreign"
            payload = self._owned_container_payload(context, output_dir, labels=foreign)
            calls = []

            def docker_run(argv, **kwargs):
                calls.append(argv)
                return SimpleNamespace(returncode=0, stdout=json.dumps([payload]), stderr="")

            result = benchmark._cleanup_benchmark_container(context, output_dir, run=docker_run)
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][:4], ["docker", "container", "inspect", identity["name"]])

    def test_execute_timeout_writes_terminal_result_after_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            timeout = subprocess.TimeoutExpired(["docker", "compose"], timeout=3)
            with patch.object(benchmark.subprocess, "run", side_effect=timeout), patch.object(
                benchmark,
                "_cleanup_benchmark_container",
                return_value={"status": "removed", "verified": True},
            ):
                result_code = benchmark._execute(
                    context,
                    output_dir,
                    ("c1",),
                    ["docker", "compose"],
                    timeout_seconds=30.0,
                )
            self.assertEqual(result_code, 1)
            result = json.loads((output_dir / "run-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "failed")
            self.assertTrue(result["timed_out"])
            self.assertFalse(result["container_timed_out"])
            self.assertEqual(result["cleanup"]["status"], "removed")
            request = json.loads((output_dir / "run-request.json").read_text(encoding="utf-8"))
            self.assertEqual(request["lifecycle"]["container_timeout_seconds"], 30)
            self.assertEqual(request["lifecycle"]["host_timeout_seconds"], 120)

    def test_execute_start_errors_and_interrupts_still_write_terminal_receipt(self):
        for raised in (OSError("docker unavailable"), KeyboardInterrupt()):
            with self.subTest(exception=type(raised).__name__), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                context = self.fake_context(root)
                output_dir = root / "output"
                with patch.object(benchmark.subprocess, "run", side_effect=raised), patch.object(
                    benchmark,
                    "_cleanup_benchmark_container",
                    return_value={"status": "blocked", "reason": "test"},
                ):
                    result_code = benchmark._execute(
                        context,
                        output_dir,
                        ("c1",),
                        ["docker", "compose"],
                        timeout_seconds=30.0,
                    )
                self.assertEqual(result_code, 1)
                result = json.loads((output_dir / "run-result.json").read_text(encoding="utf-8"))
                self.assertEqual(result["status"], "failed")
                self.assertEqual(result["cleanup"]["status"], "blocked")
                if isinstance(raised, KeyboardInterrupt):
                    self.assertTrue(result["interrupted"])
                else:
                    self.assertIn("could not start", result["execution_error"])

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

    def test_execute_attaches_scientific_gate_and_keeps_unqualified_result_when_gate_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            context = self.fake_context(root)
            output_dir = root / "output"
            failed_gate = {
                "schema_version": benchmark.SCIENTIFIC_GATE_SCHEMA,
                "status": "not_qualified",
                "qualification": "NOT VERIFIED",
                "reasons": ["missing scientific evidence bundle"],
            }
            with patch.object(
                benchmark.subprocess,
                "run",
                return_value=SimpleNamespace(returncode=0),
            ), patch.object(
                benchmark,
                "_validate_case_artifacts",
                side_effect=lambda case_dir, case: {"case": case},
            ), patch.object(
                benchmark,
                "validate_scientific_case",
                return_value=failed_gate,
            ), patch.object(
                benchmark,
                "validate_requested_cases",
                return_value={
                    "schema_version": benchmark.SCIENTIFIC_GATE_SCHEMA,
                    "status": "not_qualified",
                    "qualification": "NOT VERIFIED",
                    "reasons": ["missing scientific evidence bundle"],
                },
            ), patch.object(
                benchmark,
                "_write_scientific_evidence",
                return_value=None,
            ):
                result_code = benchmark._execute(
                    context,
                    output_dir,
                    ("c0",),
                    ["docker", "compose"],
                    timeout_seconds=30.0,
                )
            self.assertEqual(result_code, 0)
            result = json.loads((output_dir / "run-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "completed_unqualified")
            self.assertEqual(result["qualification"], "NOT VERIFIED")
            self.assertEqual(result["cases"][0]["scientific_gate"], failed_gate)
            self.assertEqual(result["scientific_gate"]["status"], "not_qualified")

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
