from __future__ import annotations

from contextlib import redirect_stderr
import copy
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import benchmark_fem_mixed_mesh_pipeline as benchmark
import qualify_fem_mixed_repair_policy as qualification
from fullmag.meshing import _gmsh_swept as swept


def _candidate_document(
    method: str,
    *,
    runs: int = 10,
    total_s: float = 10.0,
    non_manifold_faces: int = 0,
    same_side_two_owner_faces: int = 0,
    relative_volume_error: float = 0.0,
    p05: float = 0.2,
    degraded: bool = False,
    algorithm_id: str | None = None,
    policy_method: str | None = None,
    iterations: int = 1,
) -> dict[str, object]:
    quality = {
        "requested_layers": 1,
        "realized_layers": 1,
        "non_manifold_faces": non_manifold_faces,
        "same_side_two_owner_faces": same_side_two_owner_faces,
        "relative_volume_error": relative_volume_error,
        "scaled_jacobian_p05_by_family": {
            "prism6": p05,
            "pyramid5": p05,
            "tet4": p05,
        },
    }
    run_rows = [
        {
            "kind": "cold",
            "index": index,
            "timings": {"total_s": total_s},
            "topology_fingerprint_v3": "a" * 64,
            "quality": copy.deepcopy(quality),
            "degraded": degraded,
            "memory_status": "measured",
        }
        for index in range(runs)
    ]
    benchmark_document = {
        "schema": "fullmag.fem-mixed-mesh-performance.v1",
        "scenario": {
            "id": "sp4_mixed",
            "requested_layers": 1,
            "repair_method": method,
            "gmsh_threads": 1,
            "rayon_threads": 1,
        },
        "mesh": {
            "nodes": 10,
            "cells": 20,
            "facets": 30,
            "topology_fingerprint_v3": "a" * 64,
        },
        "quality": quality,
        "runs": run_rows,
        "summary": {
            "timings": {
                "total_s": {"p50": total_s, "p95": total_s, "max": total_s}
            }
        },
        "gate": {"status": "release_pass", "failures": []},
    }
    if algorithm_id is None:
        algorithm_id = (
            swept._STRICT_MIXED_TET_REPAIR_POLICY.algorithm_id
            if method == "Relocate3D"
            else swept._qualification_mixed_tet_repair_algorithm_id(
                "" if method == "default" else method,
                iterations,
            )
        )
    if policy_method is None:
        policy_method = "" if method == "default" else method
    return {
        "schema": "fullmag.fem-mixed-repair-policy-worker-evidence.v1",
        "repair_policy": {
            "algorithm_id": algorithm_id,
            "method": policy_method,
            "iterations": iterations,
        },
        "benchmark": benchmark_document,
    }


class RepairPolicyQualificationTests(unittest.TestCase):
    def test_worker_selector_executes_policy_while_probe_wraps_public_repair(
        self,
    ) -> None:
        gmsh = Mock()
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)

            def run_benchmark(
                config: benchmark.BenchmarkConfig,
                *,
                mode: str,
            ) -> dict[str, object]:
                self.assertEqual(mode, "qualification")
                with benchmark._mesh_phase_probe({}, config.repair_method_override):
                    swept._repair_mixed_tetrahedra(gmsh)
                return _candidate_document("Netgen")["benchmark"]

            with (
                patch.object(swept, "_import_gmsh", return_value=gmsh),
                patch.object(benchmark, "_run_benchmark", side_effect=run_benchmark),
                patch.object(benchmark, "validate_evidence_document"),
            ):
                qualification._run_worker(
                    scenario="sp4_mixed",
                    runs=10,
                    method="Netgen",
                    gmsh_threads=1,
                    evidence_output=root / "netgen.json",
                    artifact_dir=root / "artifacts",
                )

        gmsh.model.mesh.optimize.assert_called_once_with("Netgen", niter=1)

    def test_cli_requires_the_exact_canonical_candidate_matrix(self) -> None:
        invalid = (
            "default,Relocate3D",
            "Relocate3D,default,Netgen",
            "default,Relocate3D,Relocate3D,Netgen",
        )
        for methods in invalid:
            with (
                self.subTest(methods=methods),
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit),
            ):
                qualification._parse_args(
                    [
                        "--scenario",
                        "sp4_mixed",
                        "--runs",
                        "10",
                        "--gmsh-threads",
                        "1",
                        "--methods",
                        methods,
                        "--output",
                        "/tmp/repair-policy.json",
                    ]
                )

    def test_config_requires_the_exact_canonical_candidate_matrix(self) -> None:
        invalid = (
            ("default", "Relocate3D"),
            ("Relocate3D", "default", "Netgen"),
            ("default", "Relocate3D", "Relocate3D", "Netgen"),
        )
        for methods in invalid:
            with self.subTest(methods=methods), self.assertRaisesRegex(
                ValueError,
                "exactly default,Relocate3D,Netgen",
            ):
                qualification._validate_config(
                    qualification.QualificationConfig(
                        scenario="sp4_mixed",
                        runs=10,
                        methods=methods,
                        gmsh_threads=1,
                        output=Path("/tmp/repair-policy.json"),
                    )
                )

    def test_runs_each_candidate_in_a_separate_subprocess(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            config = qualification.QualificationConfig(
                scenario="sp4_mixed",
                runs=10,
                methods=("default", "Relocate3D", "Netgen"),
                gmsh_threads=1,
                output=(root / "repair-policy.v1.json").resolve(),
            )
            commands: list[list[str]] = []

            def run_process(
                command: list[str], **_kwargs: object
            ) -> subprocess.CompletedProcess[str]:
                commands.append(command)
                evidence_path = Path(command[command.index("--evidence-output") + 1])
                method = command[command.index("--method") + 1]
                evidence_path.parent.mkdir(parents=True, exist_ok=True)
                evidence_path.write_text(
                    json.dumps(_candidate_document(method)), encoding="utf-8"
                )
                return subprocess.CompletedProcess(command, 0, "", "")

            document = qualification.run_qualification(
                config,
                run_process=run_process,
            )

            self.assertEqual(len(commands), 3)
            self.assertTrue(all("--worker" in command for command in commands))
            self.assertEqual(
                [command[command.index("--method") + 1] for command in commands],
                ["default", "Relocate3D", "Netgen"],
            )
            self.assertEqual(
                len({row["evidence_path"] for row in document["candidates"]}),
                3,
            )

    def test_quality_gates_reject_nonconformity_volume_and_jacobian_regressions(
        self,
    ) -> None:
        cases = (
            (_candidate_document("Relocate3D", non_manifold_faces=1), "non-manifold"),
            (_candidate_document("Relocate3D", same_side_two_owner_faces=1), "same-side"),
            (_candidate_document("Relocate3D", relative_volume_error=1.1e-8), "volume"),
            (_candidate_document("Relocate3D", p05=0.099), "p05"),
            (_candidate_document("Relocate3D", degraded=True), "degraded"),
        )
        for document, message in cases:
            with self.subTest(message=message):
                failures = qualification.candidate_quality_failures(
                    document,
                    expected_runs=10,
                )
                self.assertTrue(any(message in failure for failure in failures))

    def test_requires_exactly_ten_cold_runs_for_relocate3d(self) -> None:
        failures = qualification.candidate_quality_failures(
            _candidate_document("Relocate3D", runs=9),
            expected_runs=10,
        )

        self.assertTrue(any("10 cold runs" in failure for failure in failures))

    def test_netgen_is_rejected_by_preserved_regression_control_even_if_live_run_passes(
        self,
    ) -> None:
        row = qualification.evaluate_candidate(
            "Netgen",
            _candidate_document("Netgen"),
            expected_runs=10,
        )

        self.assertFalse(row["legal"])
        self.assertEqual(
            row["regression_control"],
            qualification.PRESERVED_NETGEN_REGRESSION_CONTROL,
        )
        self.assertTrue(any("Netgen" in failure for failure in row["failures"]))

    def test_time_ranks_only_legal_candidates(self) -> None:
        rows = [
            qualification.evaluate_candidate(
                "default",
                _candidate_document("default", total_s=9.0),
                expected_runs=10,
            ),
            qualification.evaluate_candidate(
                "Relocate3D",
                _candidate_document("Relocate3D", total_s=10.0),
                expected_runs=10,
            ),
            qualification.evaluate_candidate(
                "Netgen",
                _candidate_document("Netgen", total_s=1.0),
                expected_runs=10,
            ),
        ]

        self.assertEqual(qualification.fastest_legal_method(rows), "default")

    def test_relocate_candidate_evidence_uses_immutable_production_id(
        self,
    ) -> None:
        row = qualification.evaluate_candidate(
            "Relocate3D",
            _candidate_document("Relocate3D"),
            expected_runs=10,
        )

        self.assertEqual(
            row["algorithm_id"],
            swept._STRICT_MIXED_TET_REPAIR_POLICY.algorithm_id,
        )
        self.assertEqual(row["method"], "Relocate3D")
        self.assertEqual(row["iterations"], 1)

    def test_default_and_netgen_use_deterministic_qualification_ids(self) -> None:
        for method in ("default", "Netgen"):
            with self.subTest(method=method):
                row = qualification.evaluate_candidate(
                    method,
                    _candidate_document(method),
                    expected_runs=10,
                )
                self.assertEqual(
                    row["algorithm_id"],
                    swept._qualification_mixed_tet_repair_algorithm_id(
                        "" if method == "default" else method,
                        1,
                    ),
                )
                self.assertEqual(row["iterations"], 1)

    def test_candidate_rejects_mismatched_policy_identity_before_legal(self) -> None:
        cases = (
            {"algorithm_id": "wrong"},
            {"policy_method": "Netgen"},
            {"iterations": 2},
            {"iterations": True},
        )
        for overrides in cases:
            with self.subTest(overrides=overrides):
                row = qualification.evaluate_candidate(
                    "Relocate3D",
                    _candidate_document("Relocate3D", **overrides),
                    expected_runs=10,
                )
                self.assertFalse(row["legal"])
                self.assertTrue(
                    any("repair policy" in failure for failure in row["failures"])
                )

    def test_candidate_rejects_evidence_for_a_different_method(self) -> None:
        row = qualification.evaluate_candidate(
            "Relocate3D",
            _candidate_document("default"),
            expected_runs=10,
        )

        self.assertFalse(row["legal"])
        self.assertTrue(
            any("repair method" in failure for failure in row["failures"])
        )

    def test_relocate3d_failure_blocks_mesher_quality_without_default_fallback(
        self,
    ) -> None:
        rows = [
            qualification.evaluate_candidate(
                "default", _candidate_document("default"), expected_runs=10
            ),
            qualification.evaluate_candidate(
                "Relocate3D",
                _candidate_document("Relocate3D", non_manifold_faces=1),
                expected_runs=10,
            ),
        ]

        decision = qualification.decide_matrix_status(rows)

        self.assertEqual(decision["status"], "BLOCKED_MESHER_QUALITY")
        self.assertIsNone(decision["selected_production_method"])
        self.assertEqual(decision["failing_topology_fingerprint_v3"], "a" * 64)

    def test_storage_failure_is_classified_as_infrastructure(self) -> None:
        self.assertEqual(
            qualification.classify_worker_failure(
                "OSError: [Errno 28] No space left on device"
            ),
            "BLOCKED_INFRASTRUCTURE",
        )
        self.assertEqual(
            qualification.classify_worker_failure(
                "mixed shared-domain conformity validation failed"
            ),
            "BLOCKED_MESHER_QUALITY",
        )


if __name__ == "__main__":
    unittest.main()
