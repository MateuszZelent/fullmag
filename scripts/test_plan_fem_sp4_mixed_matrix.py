from __future__ import annotations

import csv
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

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
            plan["source_commit_full"],
            subprocess.check_output(
                ["git", "rev-parse", "--verify", "HEAD"],
                cwd=REPO_ROOT,
            ).decode("ascii").strip(),
        )
        self.assertEqual(
            plan["source_tree_sha256"],
            hashlib.sha256(
                subprocess.check_output(
                    ["git", "ls-tree", "-r", "--full-tree", "HEAD"],
                    cwd=REPO_ROOT,
                )
            ).hexdigest(),
        )
        expected_sources = (
            "scripts/plan_fem_sp4_mixed_matrix.py",
            "tests/standard_problems/mumag/sp4/common/contract.py",
            contract_relative,
        )
        self.assertEqual(tuple(source_hashes), expected_sources)
        for relative_path in expected_sources:
            self.assertEqual(
                source_hashes[relative_path],
                hashlib.sha256((REPO_ROOT / relative_path).read_bytes()).hexdigest(),
            )
        self.assertEqual(plan["contract_sha256"], source_hashes[contract_relative])

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
