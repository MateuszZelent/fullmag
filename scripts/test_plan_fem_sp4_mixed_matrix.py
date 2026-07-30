from __future__ import annotations

import csv
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import scripts.plan_fem_sp4_mixed_matrix as planner
from tests.standard_problems.mumag.sp4.common.contract import (
    PRODUCTION_RELAXATION_ALGORITHMS,
)


REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "scripts" / "plan_fem_sp4_mixed_matrix.py"
MATRIX_CONTRACT = (
    REPO_ROOT
    / "tests"
    / "standard_problems"
    / "mumag"
    / "sp4"
    / "fem"
    / "matrix_contract.py"
)
OUTPUT_FILES = (
    "matrix-plan.v1.json",
    "run-specs.v1.jsonl",
    "run-specs.v1.tsv",
)
PROBLEM_SOURCE = "tests/standard_problems/mumag/sp4/fem/problem.py"
DISPATCH_SOURCE = "crates/fullmag-runner/src/dispatch.rs"
EXPECTED_RELEVANT_SOURCES = (
    "justfile",
    "scripts/check_fem_sp4_relaxation.py",
    "scripts/plan_fem_sp4_mixed_matrix.py",
    "scripts/select_fem_sp4_relaxation_state.py",
    "scripts/verify_fem_standard_problem_4.sh",
    "scripts/write_fem_magnetic_initial_state_from_shared_domain.py",
    "tests/standard_problems/mumag/sp4/common/contract.py",
    "tests/standard_problems/mumag/sp4/common/metrics.py",
    "tests/standard_problems/mumag/sp4/common/references.py",
    "tests/standard_problems/mumag/sp4/common/reporting.py",
    "tests/standard_problems/mumag/sp4/fem/matrix_contract.py",
    PROBLEM_SOURCE,
    "tests/standard_problems/mumag/sp4/fem/scenarios/relax_llg_rk23_adaptive.py",
    "tests/standard_problems/mumag/sp4/fem/scenarios/relax_nonlinear_cg.py",
    "tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py",
    "tests/standard_problems/mumag/sp4/fem/verify.py",
)


def _canonical_json(value: object) -> bytes:
    return (
        json.dumps(
            value,
            allow_nan=False,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


class FemSp4MixedMatrixPlannerTest(unittest.TestCase):
    def _git(self, root: Path, *arguments: str) -> str:
        return subprocess.check_output(
            ("git", *arguments),
            cwd=root,
        ).decode("utf-8").strip()

    def _source_repo(self, directory: str) -> Path:
        root = Path(directory) / "source"
        for relative_path in EXPECTED_RELEVANT_SOURCES:
            destination = root / relative_path
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO_ROOT / relative_path, destination)
        dispatch = root / DISPATCH_SOURCE
        dispatch.parent.mkdir(parents=True, exist_ok=True)
        dispatch.write_text("committed dispatch source\n", encoding="utf-8")
        self._git(root, "init", "--quiet")
        self._git(root, "config", "user.name", "Fullmag Test")
        self._git(root, "config", "user.email", "fullmag-test@example.invalid")
        self._git(root, "add", "--all")
        self._git(root, "commit", "--quiet", "-m", "fixture")
        return root

    def _run(self, stage: str, output_dir: Path) -> dict[str, object]:
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                stage,
                "--output-dir",
                str(output_dir),
            ],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads((output_dir / OUTPUT_FILES[0]).read_text(encoding="utf-8"))

    def test_stages_have_exact_counts_and_declare_only_identity_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            stage1 = self._run("stage1-layers", root / "stage1")
            stage2 = self._run("stage2-airbox", root / "stage2")
            stage3 = self._run("stage3-device", root / "stage3")

        stage1_specs = stage1["run_specs"]
        stage2_specs = stage2["run_specs"]
        stage3_specs = stage3["run_specs"]
        self.assertEqual(len(stage1_specs), 9)
        self.assertEqual(len(stage2_specs), 6)
        self.assertEqual(len(stage3_specs), 6)
        self.assertTrue(all(spec["disposition"] == "execute" for spec in stage1_specs))
        self.assertTrue(all(spec["reuse_from_stage"] is None for spec in stage1_specs))
        for specs in (stage2_specs, stage3_specs):
            self.assertEqual(
                [spec["run_id"] for spec in specs[:3]],
                [
                    spec["run_id"]
                    for spec in stage1_specs
                    if spec["layers"] == 1
                ],
            )
            self.assertTrue(all(spec["disposition"] == "reuse" for spec in specs[:3]))
            self.assertTrue(
                all(spec["reuse_from_stage"] == "stage1-layers" for spec in specs[:3])
            )
            self.assertTrue(all(spec["disposition"] == "execute" for spec in specs[3:]))
            self.assertTrue(all(spec["reuse_from_stage"] is None for spec in specs[3:]))

    def test_every_required_axis_is_exact_and_no_run_is_silently_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plans = {
                stage: self._run(stage, root / stage)
                for stage in ("stage1-layers", "stage2-airbox", "stage3-device")
            }

        algorithms = PRODUCTION_RELAXATION_ALGORITHMS
        stage1_axes = {
            (spec["layers"], spec["relaxation_algorithm"])
            for spec in plans["stage1-layers"]["run_specs"]
        }
        self.assertEqual(
            stage1_axes,
            {(layers, algorithm) for layers in (1, 2, 3) for algorithm in algorithms},
        )
        stage2_axes = {
            (spec["airbox_id"], spec["relaxation_algorithm"])
            for spec in plans["stage2-airbox"]["run_specs"]
        }
        self.assertEqual(
            stage2_axes,
            {
                (airbox, algorithm)
                for airbox in ("baseline", "expanded")
                for algorithm in algorithms
            },
        )
        stage3_axes = {
            (spec["device"], spec["relaxation_algorithm"])
            for spec in plans["stage3-device"]["run_specs"]
        }
        self.assertEqual(
            stage3_axes,
            {
                (device, algorithm)
                for device in ("cpu", "gpu")
                for algorithm in algorithms
            },
        )

        required_keys = {
            "run_id",
            "artifact_path",
            "stage_id",
            "phase",
            "topology_variant",
            "layers",
            "layer_key",
            "mesh_level",
            "mesh_hmax_m",
            "airbox_id",
            "airbox_dimensions_m",
            "airbox_hmax_m",
            "device",
            "relaxation_algorithm",
            "case",
            "dynamics_policy",
            "dynamics_level",
            "disposition",
            "reuse_from_stage",
        }
        for plan in plans.values():
            for spec in plan["run_specs"]:
                self.assertTrue(required_keys.issubset(spec))
                self.assertEqual(spec["phase"], "relax")
                self.assertEqual(spec["topology_variant"], "mixed_p1")
                self.assertIn(spec["layers"], (1, 2, 3))
                self.assertEqual(spec["layer_key"], f"layers-{spec['layers']}")
                self.assertEqual(spec["mesh_level"], "medium")
                self.assertEqual(spec["mesh_hmax_m"], 2e-9)
                self.assertIn(spec["airbox_id"], ("baseline", "expanded"))
                self.assertEqual(len(spec["airbox_dimensions_m"]), 3)
                self.assertEqual(spec["airbox_hmax_m"], 20e-9)
                self.assertIn(spec["device"], ("cpu", "gpu"))
                self.assertIn(spec["relaxation_algorithm"], algorithms)
                self.assertIsNone(spec["case"])
                self.assertIsNone(spec["dynamics_policy"])
                self.assertIsNone(spec["dynamics_level"])

    def test_run_ids_paths_and_machine_readable_outputs_are_unique_and_equal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "plan"
            plan = self._run("stage2-airbox", output_dir)
            jsonl_rows = [
                json.loads(line)
                for line in (output_dir / OUTPUT_FILES[1]).read_text(encoding="utf-8").splitlines()
            ]
            tsv_rows = list(
                csv.DictReader(
                    io.StringIO(
                        (output_dir / OUTPUT_FILES[2]).read_text(encoding="utf-8")
                    ),
                    delimiter="\t",
                )
            )

        specs = plan["run_specs"]
        run_ids = [spec["run_id"] for spec in specs]
        artifact_paths = [spec["artifact_path"] for spec in specs]
        self.assertEqual(len(run_ids), len(set(run_ids)))
        self.assertEqual(len(artifact_paths), len(set(artifact_paths)))
        self.assertEqual(jsonl_rows, specs)
        self.assertEqual([row["run_id"] for row in tsv_rows], run_ids)
        self.assertEqual([row["artifact_path"] for row in tsv_rows], artifact_paths)
        self.assertTrue(all(not Path(path).is_absolute() for path in artifact_paths))

    def test_plan_bytes_and_content_hash_are_deterministic_and_canonical(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = self._run("stage3-device", root / "first")
            second = self._run("stage3-device", root / "second")
            first_bytes = {
                name: (root / "first" / name).read_bytes() for name in OUTPUT_FILES
            }
            second_bytes = {
                name: (root / "second" / name).read_bytes() for name in OUTPUT_FILES
            }

        self.assertEqual(first, second)
        self.assertEqual(first_bytes, second_bytes)
        self.assertEqual(first_bytes[OUTPUT_FILES[0]], _canonical_json(first))
        hash_payload = dict(first)
        plan_sha256 = hash_payload.pop("plan_sha256")
        self.assertEqual(
            plan_sha256,
            hashlib.sha256(_canonical_json(hash_payload)).hexdigest(),
        )
        self.assertEqual(
            hashlib.sha256(first_bytes[OUTPUT_FILES[0]]).hexdigest(),
            hashlib.sha256(second_bytes[OUTPUT_FILES[0]]).hexdigest(),
        )

    def test_manifest_binds_source_identity_and_never_promotes_capability(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            plan = self._run("stage1-layers", Path(directory) / "plan")

        source_hashes = plan["relevant_source_files_sha256"]
        contract_relative = MATRIX_CONTRACT.relative_to(REPO_ROOT).as_posix()
        self.assertEqual(plan["schema"], "fullmag.fem.sp4.mixed-matrix-plan.v1")
        self.assertEqual(plan["requested_stage"], "stage1-layers")
        self.assertIs(plan["qualifying"], False)
        self.assertEqual(plan["qualification_claim"], "implemented_evidence_only")
        self.assertNotIn("capabilities", plan)
        self.assertEqual(
            plan.get("head_commit_full"),
            subprocess.check_output(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=REPO_ROOT,
            ).decode("ascii").strip(),
        )
        self.assertEqual(
            plan.get("head_tree_sha256"),
            hashlib.sha256(
                subprocess.check_output(
                    ["git", "ls-tree", "-r", "--full-tree", "HEAD"],
                    cwd=REPO_ROOT,
                )
            ).hexdigest(),
        )
        self.assertTrue(set(EXPECTED_RELEVANT_SOURCES).issubset(source_hashes))
        for relative_path in EXPECTED_RELEVANT_SOURCES:
            self.assertEqual(
                source_hashes[relative_path],
                hashlib.sha256((REPO_ROOT / relative_path).read_bytes()).hexdigest(),
            )
        self.assertEqual(plan["contract_sha256"], source_hashes[contract_relative])
        self.assertNotIn("source_commit_full", plan)
        self.assertNotIn("source_tree_sha256", plan)

    def test_dirty_execution_source_is_bound_to_explicit_snapshot_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_root = self._source_repo(directory)
            with mock.patch.object(planner, "REPO_ROOT", source_root):
                clean = planner.build_plan("stage1-layers")
                problem = source_root / PROBLEM_SOURCE
                problem.write_text(
                    problem.read_text(encoding="utf-8")
                    + "\n# dirty execution source\n",
                    encoding="utf-8",
                )

                dirty = planner.build_plan("stage1-layers")

        expected_status = [{"status": " M", "paths": [PROBLEM_SOURCE]}]
        self.assertIs(clean.get("source_snapshot_dirty"), False)
        self.assertEqual(clean.get("dirty_paths"), [])
        self.assertIs(dirty["source_snapshot_dirty"], True)
        self.assertEqual(dirty["git_status_porcelain_v1"], expected_status)
        self.assertEqual(dirty["dirty_paths"], [PROBLEM_SOURCE])
        self.assertEqual(
            dirty["git_status_sha256"],
            hashlib.sha256(_canonical_json(expected_status)).hexdigest(),
        )
        self.assertEqual(dirty["head_commit_full"], clean["head_commit_full"])
        self.assertEqual(dirty["head_tree_sha256"], clean["head_tree_sha256"])
        self.assertNotEqual(
            dirty["relevant_source_files_sha256"][PROBLEM_SOURCE],
            clean["relevant_source_files_sha256"][PROBLEM_SOURCE],
        )
        if "dirty_path_content" not in dirty:
            self.fail("dirty snapshot must bind dirty_path_content")
        snapshot_payload = {
            key: dirty[key]
            for key in (
                "head_commit_full",
                "head_tree_sha256",
                "git_status_porcelain_v1",
                "dirty_path_content",
                "relevant_source_files_sha256",
            )
        }
        self.assertEqual(
            dirty["source_snapshot_sha256"],
            hashlib.sha256(_canonical_json(snapshot_payload)).hexdigest(),
        )
        self.assertNotEqual(dirty["source_snapshot_sha256"], clean["source_snapshot_sha256"])

    def test_dirty_source_outside_curated_set_changes_snapshot_with_its_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_root = self._source_repo(directory)
            dispatch = source_root / DISPATCH_SOURCE
            with mock.patch.object(planner, "REPO_ROOT", source_root):
                dispatch.write_text("dirty variant A\n", encoding="utf-8")
                first = planner.build_plan("stage1-layers")
                dispatch.write_text("dirty variant B\n", encoding="utf-8")
                second = planner.build_plan("stage1-layers")

        self.assertEqual(
            first["git_status_porcelain_v1"],
            second["git_status_porcelain_v1"],
        )
        self.assertEqual(first["dirty_paths"], [DISPATCH_SOURCE])
        self.assertEqual(second["dirty_paths"], [DISPATCH_SOURCE])
        self.assertNotEqual(first.get("dirty_path_content"), second.get("dirty_path_content"))
        self.assertNotEqual(first["source_snapshot_sha256"], second["source_snapshot_sha256"])

    def test_deleted_dirty_source_outside_curated_set_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_root = self._source_repo(directory)
            (source_root / DISPATCH_SOURCE).unlink()

            with mock.patch.object(planner, "REPO_ROOT", source_root):
                with self.assertRaisesRegex(planner.PlanError, "missing dirty path"):
                    planner.build_plan("stage1-layers")

    def test_missing_execution_source_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_root = self._source_repo(directory)
            (source_root / PROBLEM_SOURCE).unlink()

            with mock.patch.object(planner, "REPO_ROOT", source_root):
                with self.assertRaisesRegex(planner.PlanError, "required source file"):
                    planner.build_plan("stage1-layers")

    def test_conflicting_existing_output_set_is_not_partially_modified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "plan"
            output_dir.mkdir()
            conflict = output_dir / OUTPUT_FILES[2]
            conflict.write_bytes(b"conflicting-tsv\n")

            with self.assertRaisesRegex(planner.PlanError, "incomplete or conflicting"):
                planner.emit_plan("stage1-layers", output_dir)

            self.assertEqual(
                {path.name: path.read_bytes() for path in output_dir.iterdir()},
                {OUTPUT_FILES[2]: b"conflicting-tsv\n"},
            )
            self.assertEqual(list(output_dir.parent.glob(".plan.tmp-*")), [])

    def test_staged_write_failure_exposes_no_output_and_cleans_transaction(self) -> None:
        original_open = Path.open

        def fail_jsonl(path: Path, *args, **kwargs):
            mode = args[0] if args else kwargs.get("mode", "r")
            if path.name == OUTPUT_FILES[1] and any(
                flag in mode for flag in ("w", "x")
            ):
                raise OSError("injected JSONL write failure")
            return original_open(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "plan"
            with mock.patch.object(Path, "open", fail_jsonl):
                with self.assertRaisesRegex(planner.PlanError, "cannot write plan output"):
                    planner.emit_plan("stage1-layers", output_dir)

            self.assertFalse(output_dir.exists())
            self.assertEqual(list(output_dir.parent.glob(".plan.tmp-*")), [])
            lock_path = output_dir.parent / ".plan.lock"
            if not lock_path.exists():
                self.fail("advisory lock file must remain available for process locking")
            with lock_path.open("r+") as lock_stream:
                fcntl.flock(lock_stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(lock_stream.fileno(), fcntl.LOCK_UN)

    def test_cleanup_failure_preserves_primary_error_and_releases_lock_for_retry(
        self,
    ) -> None:
        original_open = Path.open

        def fail_jsonl(path: Path, *args, **kwargs):
            mode = args[0] if args else kwargs.get("mode", "r")
            if path.name == OUTPUT_FILES[1] and any(
                flag in mode for flag in ("w", "x")
            ):
                raise OSError("injected JSONL write failure")
            return original_open(path, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "plan"
            with mock.patch.object(Path, "open", fail_jsonl), mock.patch.object(
                shutil,
                "rmtree",
                side_effect=OSError("injected cleanup failure"),
            ):
                with self.assertRaises(planner.PlanError) as raised:
                    planner.emit_plan("stage1-layers", output_dir)

            message = str(raised.exception)
            self.assertIn("injected JSONL write failure", message)
            self.assertIn("injected cleanup failure", message)
            self.assertFalse(output_dir.exists())
            try:
                retry = planner.emit_plan("stage1-layers", output_dir)
            except planner.PlanError as error:
                self.fail(f"released lock must permit retry: {error}")
            self.assertEqual(retry["requested_stage"], "stage1-layers")

    def test_existing_complete_plan_is_idempotent_and_lock_blocks_concurrent_writer(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output_dir = root / "complete"
            first = planner.emit_plan("stage1-layers", output_dir)
            original = {name: (output_dir / name).read_bytes() for name in OUTPUT_FILES}

            second = planner.emit_plan("stage1-layers", output_dir)
            self.assertEqual(second, first)
            self.assertEqual(
                {name: (output_dir / name).read_bytes() for name in OUTPUT_FILES},
                original,
            )

            concurrent_output = root / "concurrent"
            lock = root / ".concurrent.lock"
            lock_descriptor = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
            fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                with self.assertRaisesRegex(
                    planner.PlanError,
                    "emission is already in progress",
                ):
                    planner.emit_plan("stage1-layers", concurrent_output)
            finally:
                fcntl.flock(lock_descriptor, fcntl.LOCK_UN)
                os.close(lock_descriptor)
            self.assertFalse(concurrent_output.exists())
            try:
                recovered = planner.emit_plan("stage1-layers", concurrent_output)
            except planner.PlanError as error:
                self.fail(f"stale lock file must be recoverable: {error}")
            self.assertEqual(recovered["requested_stage"], "stage1-layers")

    def test_in_repo_output_is_idempotent_and_only_its_owned_status_is_excluded(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source_root = self._source_repo(directory)
            output_dir = source_root / "matrix-output"
            with mock.patch.object(planner, "REPO_ROOT", source_root):
                first = planner.emit_plan("stage1-layers", output_dir)
                original = {
                    name: (output_dir / name).read_bytes() for name in OUTPUT_FILES
                }
                try:
                    second = planner.emit_plan("stage1-layers", output_dir)
                except planner.PlanError as error:
                    self.fail(f"in-repo identical plan must be idempotent: {error}")

                unrelated = output_dir / "unrelated-source.txt"
                unrelated.write_text("must remain visible\n", encoding="utf-8")
                try:
                    visible = planner.build_plan(
                        "stage1-layers",
                        output_dir=output_dir,
                    )
                except TypeError as error:
                    self.fail(f"planner must accept its output status scope: {error}")
                self.assertEqual(second, first)
                self.assertEqual(
                    {name: (output_dir / name).read_bytes() for name in OUTPUT_FILES},
                    original,
                )
                self.assertEqual(
                    visible["dirty_paths"],
                    ["matrix-output/unrelated-source.txt"],
                )

    def test_unknown_stage_fails_closed_without_writing_a_plan(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory) / "plan"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "stage4",
                    "--output-dir",
                    str(output_dir),
                ],
                cwd=REPO_ROOT,
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(output_dir.exists())


if __name__ == "__main__":
    unittest.main()
