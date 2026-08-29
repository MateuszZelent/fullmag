from __future__ import annotations

from contextlib import redirect_stderr
import copy
from dataclasses import replace
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import numpy as np

import benchmark_fem_mixed_mesh_pipeline as benchmark
import qualify_fem_mixed_repair_policy as qualification
from fullmag.meshing import _gmsh_swept as swept
from fullmag.meshing._gmsh_types import MeshData


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
    tet_minimum: float = 0.2,
    mesh_nodes: int = 10,
    mesh_cells: int = 20,
    mesh_facets: int = 30,
    topology_fingerprint: str = "a" * 64,
) -> dict[str, object]:
    quality = {
        "requested_layers": 1,
        "realized_layers": 1,
        "magnetic_plane_count": 2,
        "cell_family_counts_by_part": {
            "magnetic": {"prism6": 4},
            "transition_air": {"pyramid5": 8, "tet4": 4},
            "far_air": {"tet4": 8},
        },
        "nonconforming_faces": 0,
        "orphan_faces": 0,
        "non_manifold_faces": non_manifold_faces,
        "same_side_two_owner_faces": same_side_two_owner_faces,
        "coincident_interface_faces": 0,
        "duplicate_cells": 0,
        "fallbacks_triggered": [],
        "strict_jacobian_validation_passed": True,
        "marker_coverage_complete": True,
        "global_ordinals_complete": True,
        "relative_volume_error": relative_volume_error,
        "jacobian_minima_m3_by_family": {
            "prism6": 1.0e-24,
            "pyramid5": 1.0e-24,
            "tet4": 1.0e-24,
        },
        "scaled_jacobian_p05_by_family": {
            "prism6": p05,
            "pyramid5": p05,
            "tet4": p05,
        },
        "scaled_jacobian_minima_by_family": {
            "prism6": 0.2,
            "pyramid5": 0.2,
            "tet4": tet_minimum,
        },
    }
    run_rows = [
        {
            "kind": "cold",
            "index": index,
            "timings": {"total_s": total_s},
            "topology_fingerprint_v3": topology_fingerprint,
            "quality": copy.deepcopy(quality),
            "degraded": degraded,
            "memory_status": "measured",
        }
        for index in range(runs)
    ]
    benchmark_document = {
        "schema": "fullmag.fem-mixed-mesh-performance.v2",
        "scenario": {
            "id": "sp4_mixed",
            "requested_layers": 1,
            "repair_method": method,
            "gmsh_threads": 1,
            "rayon_threads": 1,
            "python_audit_runs": 0,
        },
        "mesh": {
            "nodes": mesh_nodes,
            "cells": mesh_cells,
            "facets": mesh_facets,
            "topology_fingerprint_v3": topology_fingerprint,
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
        selected_method = "" if method == "default" else method
        if (
            selected_method == swept._STRICT_MIXED_TET_REPAIR_POLICY.method
            and iterations == 1
        ):
            algorithm_id = swept._STRICT_MIXED_TET_REPAIR_POLICY.algorithm_id
        elif isinstance(iterations, int) and not isinstance(iterations, bool) and iterations == 1:
            algorithm_id = swept._qualification_mixed_tet_repair_algorithm_id(
                selected_method,
                iterations,
            )
        else:
            # Keep deliberately malformed overrides representable so that
            # evaluate_candidate can reject them as policy mismatches.
            algorithm_id = (
                "fullmag.mixed-tet-repair.qualification.v2."
                f"method-{selected_method}.niter-{iterations}"
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


def _partial_failing_mesh() -> MeshData:
    return MeshData(
        nodes=np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0e-6, 0.0, 0.0],
                [0.0, 1.0e-6, 0.0],
                [0.0, 0.0, 1.0e-18],
            ],
            dtype=np.float64,
        ),
        cell_types=np.asarray(["tet4"]),
        cell_offsets=np.asarray([0, 4], dtype=np.int64),
        cell_nodes=np.asarray([0, 1, 2, 3], dtype=np.int32),
        element_markers=np.asarray([0], dtype=np.int32),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0], dtype=np.int64),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
    )


class RepairPolicyQualificationTests(unittest.TestCase):
    def test_hard_failing_worker_persists_real_partial_mesh_fingerprint(self) -> None:
        partial_mesh = _partial_failing_mesh()
        partial_mesh_si = replace(partial_mesh, nodes=partial_mesh.nodes * 1.0e-6)
        gmsh = Mock()

        def run_benchmark(
            _config: benchmark.BenchmarkConfig,
            *,
            mode: str,
        ) -> dict[str, object]:
            self.assertEqual(mode, "qualification")
            with benchmark._mesh_phase_probe({}, "Relocate3D"):
                swept._repair_mixed_tetrahedra(gmsh)
            raise AssertionError("repair failure must escape the benchmark")

        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            evidence_path = root / "relocate.failure.json"
            with (
                patch.object(swept, "_import_gmsh", return_value=gmsh),
                patch.object(
                    swept,
                    "_repair_mixed_tetrahedra_for_qualification",
                    side_effect=RuntimeError("left degenerate tet4"),
                ),
                patch.object(swept, "_extract_mesh_data", return_value=partial_mesh),
                patch.object(benchmark, "_run_benchmark", side_effect=run_benchmark),
                self.assertRaisesRegex(RuntimeError, "left degenerate tet4"),
            ):
                qualification._run_worker(
                    scenario="sp4_mixed",
                    runs=10,
                    method="Relocate3D",
                    gmsh_threads=1,
                    evidence_output=evidence_path,
                    artifact_dir=root / "artifacts",
                )

            payload = json.loads(evidence_path.read_text(encoding="utf-8"))

        self.assertEqual(payload["schema"], qualification.WORKER_FAILURE_SCHEMA)
        self.assertEqual(
            payload["topology_fingerprint_v3"],
            partial_mesh_si.topology_fingerprint_v3(),
        )
        self.assertEqual(
            payload["mesh_counts"],
            {"nodes": 4, "cells": 1, "facets": 0},
        )

    def test_hard_failing_default_payload_reaches_blocked_decision(self) -> None:
        fingerprint = _partial_failing_mesh().topology_fingerprint_v3()
        with tempfile.TemporaryDirectory() as root_name:
            evidence_path = Path(root_name) / "relocate.failure.json"
            evidence_path.write_text(
                json.dumps(
                    {
                        "schema": qualification.WORKER_FAILURE_SCHEMA,
                        "topology_fingerprint_v3": fingerprint,
                        "mesh_counts": {"nodes": 4, "cells": 1, "facets": 0},
                    }
                ),
                encoding="utf-8",
            )
            row = qualification._worker_failure_row(
                "Relocate3D",
                evidence_path=evidence_path,
                returncode=1,
                stdout="",
                stderr="left degenerate tet4",
            )

        decision = qualification.decide_matrix_status([row])

        self.assertEqual(row["topology_fingerprint_v3"], fingerprint)
        self.assertEqual(decision["status"], "BLOCKED_MESHER_QUALITY")
        self.assertEqual(decision["failing_topology_fingerprint_v3"], fingerprint)

    def test_candidate_matrix_executes_each_raw_gmsh_method(self) -> None:
        for candidate, executed in (
            ("default", ""),
            ("Relocate3D", "Relocate3D"),
            ("Netgen", "Netgen"),
        ):
            with self.subTest(candidate=candidate):
                gmsh = Mock()
                gmsh.model.mesh.getElementsByType.return_value = ([], [])
                with qualification._qualification_probe_installed(candidate):
                    with benchmark._mesh_phase_probe({}, None):
                        swept._repair_mixed_tetrahedra(gmsh)
                gmsh.model.mesh.optimize.assert_called_once_with(
                    executed, force=True, niter=1
                )

    def test_worker_selector_executes_policy_while_probe_wraps_public_repair(
        self,
    ) -> None:
        gmsh = Mock()
        gmsh.model.mesh.getElementsByType.return_value = ([], [])
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

        gmsh.model.mesh.optimize.assert_called_once_with(
            "Netgen", force=True, niter=1
        )

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
                output=(root / "repair-policy.v2.json").resolve(),
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

    def test_quality_gate_rejects_degenerate_tet_even_when_p05_passes(self) -> None:
        failures = qualification.candidate_quality_failures(
            _candidate_document("Relocate3D", p05=0.2, tet_minimum=0.0),
            expected_runs=10,
        )

        self.assertTrue(any("minimum" in failure for failure in failures))

    def test_quality_gate_requires_every_brief_3_3_evidence_field(self) -> None:
        required = (
            "magnetic_plane_count",
            "cell_family_counts_by_part",
            "nonconforming_faces",
            "orphan_faces",
            "coincident_interface_faces",
            "duplicate_cells",
            "fallbacks_triggered",
            "strict_jacobian_validation_passed",
            "marker_coverage_complete",
            "global_ordinals_complete",
            "relative_volume_error",
            "jacobian_minima_m3_by_family",
            "scaled_jacobian_minima_by_family",
            "scaled_jacobian_p05_by_family",
        )
        for field in required:
            with self.subTest(field=field):
                document = _candidate_document("Relocate3D")
                for run in document["benchmark"]["runs"]:
                    del run["quality"][field]
                failures = qualification.candidate_quality_failures(
                    document,
                    expected_runs=10,
                )
                self.assertTrue(
                    any(field in failure for failure in failures),
                    failures,
                )

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

    def test_time_ranking_rejects_smaller_mesh_candidate(self) -> None:
        rows = [
            qualification.evaluate_candidate(
                "default",
                _candidate_document(
                    "default", total_s=1.0, mesh_nodes=9, mesh_cells=19
                ),
                expected_runs=10,
            ),
            qualification.evaluate_candidate(
                "Relocate3D",
                _candidate_document("Relocate3D", total_s=10.0),
                expected_runs=10,
            ),
        ]

        self.assertIsNone(qualification.fastest_legal_method(rows))
        failures = qualification.topology_equivalence_failures(rows)
        self.assertTrue(any("element counts" in failure for failure in failures))

    def test_time_ranking_rejects_different_topology_with_equal_counts(self) -> None:
        rows = [
            qualification.evaluate_candidate(
                "default",
                _candidate_document(
                    "default", total_s=1.0, topology_fingerprint="b" * 64
                ),
                expected_runs=10,
            ),
            qualification.evaluate_candidate(
                "Relocate3D",
                _candidate_document("Relocate3D", total_s=10.0),
                expected_runs=10,
            ),
        ]

        decision = qualification.decide_matrix_status(rows)

        self.assertEqual(decision["status"], "BLOCKED_TOPOLOGY_EQUIVALENCE")
        self.assertIsNone(decision["selected_production_method"])
        self.assertIsNone(decision["fastest_legal_method"])
        self.assertTrue(
            any("topology fingerprint" in failure for failure in decision["ranking_failures"])
        )

    def test_relocate_candidate_evidence_uses_production_id(
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

    def test_default_and_netgen_use_qualification_ids(self) -> None:
        for method in ("default", "Netgen"):
            with self.subTest(method=method):
                row = qualification.evaluate_candidate(
                    method,
                    _candidate_document(method),
                    expected_runs=10,
                )
                expected_id = swept._qualification_mixed_tet_repair_algorithm_id(
                    method,
                    1,
                )
                self.assertEqual(row["algorithm_id"], expected_id)
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

    def test_default_failure_blocks_mesher_quality_without_fallback(
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
