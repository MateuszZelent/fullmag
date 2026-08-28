from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib
import importlib.util
import io
import json
import math
import os
import sys
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


PACKAGE_SOURCE = Path(__file__).resolve().parents[1] / "packages" / "fullmag-py" / "src"
if str(PACKAGE_SOURCE) not in sys.path:
    sys.path.insert(0, str(PACKAGE_SOURCE))

import benchmark_fem_mixed_mesh_pipeline as benchmark
from benchmark_fem_mixed_mesh_pipeline import (
    PHASE_TIMING_FIELDS,
    BenchmarkConfig,
    validate_evidence_document,
)


def _timings() -> dict[str, float]:
    timings = {field: 0.001 for field in PHASE_TIMING_FIELDS}
    timings["cache_lookup_s"] = 0.0
    return timings


def _quality(
    *,
    relative_volume_error: float = 0.0,
    prism6: float = 0.1,
    pyramid5: float = 0.2,
    tet4: float = 0.3,
) -> dict[str, object]:
    return {
        "requested_layers": 1,
        "realized_layers": 1,
        "non_manifold_faces": 0,
        "same_side_two_owner_faces": 0,
        "relative_volume_error": relative_volume_error,
        "scaled_jacobian_p05_by_family": {
            "prism6": prism6,
            "pyramid5": pyramid5,
            "tet4": tet4,
        },
    }


def _run(
    kind: str,
    fingerprint: str = "a" * 64,
    *,
    quality: dict[str, object] | None = None,
    degraded: bool = False,
    memory_status: str = "measured",
) -> dict[str, object]:
    return {
        "kind": kind,
        "index": 0,
        "timings": _timings(),
        "python_audit_samples_s": [],
        "unavailable_phase_timings": ["cache_lookup_s"],
        "peak_rss_bytes": 1024 if memory_status == "measured" else None,
        "memory_status": memory_status,
        "topology_fingerprint_v3": fingerprint,
        "quality": copy.deepcopy(quality or _quality()),
        "degraded": degraded,
    }


def _summary() -> dict[str, object]:
    timings: dict[str, object] = {}
    for field in PHASE_TIMING_FIELDS:
        timings[field] = (
            None if field == "cache_lookup_s" else {"p50": 0.001, "p95": 0.001, "max": 0.001}
        )
    return {
        "timings": timings,
        "python_audit_s": None,
        "peak_rss_bytes": {"p50": 1024.0, "p95": 1024.0, "max": 1024.0},
    }


def _document() -> dict[str, object]:
    return {
        "schema": "fullmag.fem-mixed-mesh-performance.v2",
        "generated_at": "2026-08-27T12:00:00Z",
        "source_identity": {
            "schema": "fullmag.source-snapshot.v2",
            "head_commit_full": "a" * 40,
            "head_tree_sha256": "b" * 64,
            "git_status_porcelain_v1": [],
            "dirty_path_content": [],
            "source_snapshot_dirty": False,
            "dirty_content_sha256": "c" * 64,
            "source_snapshot_sha256": "d" * 64,
        },
        "environment": {
            "python_version": "3.12.1",
            "gmsh_version": "4.15.2",
            "certifier_algorithm": "mixed_layer_topology_certificate.v1",
            "platform": "Linux",
            "cpu_model": "test cpu",
            "logical_cpus": 1,
        },
        "scenario": {
            "id": "sp4_mixed",
            "requested_layers": 1,
            "repair_method": "Relocate3D",
            "gmsh_threads": 1,
            "rayon_threads": 1,
            "python_audit_runs": 0,
        },
        "mesh": {
            "nodes": 10,
            "cells": 20,
            "facets": 30,
            "topology_fingerprint_v3": "a" * 64,
        },
        "quality": _quality(),
        "runs": [_run("cold"), _run("warm"), _run("warm")],
        "summary": _summary(),
        "gate": {"status": "baseline_recorded", "failures": []},
    }


def _config(root: Path, **overrides: object) -> BenchmarkConfig:
    values: dict[str, object] = {
        "scenario": "sp4_mixed",
        "cold_runs": 1,
        "warm_runs": 1,
        "native_audit_runs": 0,
        "python_audit_runs": 0,
        "warmup_runs": 0,
        "artifact_dir": (root / "artifacts").resolve(),
        "output": (root / "evidence.json").resolve(),
        "repair_method_override": None,
        "rayon_threads": (1,),
        "gmsh_threads": (1,),
    }
    values.update(overrides)
    return BenchmarkConfig(**values)  # type: ignore[arg-type]


def _source_identity() -> dict[str, object]:
    return copy.deepcopy(_document()["source_identity"])  # type: ignore[return-value]


class _FakeMesh:
    n_nodes = 10
    n_elements = 20
    n_boundary_faces = 30


class BenchmarkEvidenceTests(unittest.TestCase):
    def test_fresh_sp4_authoring_import_is_mesh_free_and_returns_exact_mixed_study(
        self,
    ) -> None:
        import fullmag.world as world

        scenario_module = "tests.standard_problems.mumag.sp4.fem.problem"
        parent_module_name, _, leaf_name = scenario_module.rpartition(".")
        parent_package = importlib.import_module(parent_module_name)
        missing = object()
        previous_scenario_module = sys.modules.get(scenario_module, missing)
        previous_problem_attribute = getattr(parent_package, leaf_name, missing)
        previous_world_state = world._state
        previous_build = world.build_domain_mesh
        original_reset = world.reset
        if previous_scenario_module is not missing:
            sys.modules.pop(scenario_module)
        if previous_problem_attribute is not missing:
            delattr(parent_package, leaf_name)
        build_calls: list[str] = []

        def forbidden_build() -> None:
            build_calls.append("build_domain_mesh")
            raise AssertionError(
                "SP4 scenario import built a mesh before the measured phase"
            )

        try:
            with mock.patch.object(world, "build_domain_mesh", forbidden_build), mock.patch.object(
                world,
                "reset",
                wraps=original_reset,
            ) as reset:
                study = benchmark._author_sp4_without_meshing()
                self.assertIs(world.build_domain_mesh, forbidden_build)

            self.assertEqual(build_calls, [])
            self.assertEqual(reset.call_count, 2)
            self.assertIsNotNone(study)
            self.assertNotIsInstance(study, tuple)

            state = world._state
            self.assertEqual(state._api_surface, "study")
            self.assertIn("_mixed_p1_layers-1", state._name)
            self.assertEqual(len(state._magnets), 1)
            self.assertEqual(len(state._declared_stages), 1)
            self.assertEqual(state._declared_stages[0].stage_id, "relax")

            mesh_spec = state._magnets[0]._mesh_spec
            self.assertEqual(mesh_spec.topology, "prismatic")
            self.assertEqual(mesh_spec.through_thickness_elements, 1)
            self.assertEqual(mesh_spec.transition_policy, "pyramid_to_tetrahedra")
            self.assertTrue(mesh_spec.exact_layer_count)
        finally:
            sys.modules.pop(scenario_module, None)
            if previous_scenario_module is not missing:
                sys.modules[scenario_module] = previous_scenario_module
            if previous_problem_attribute is missing:
                if hasattr(parent_package, leaf_name):
                    delattr(parent_package, leaf_name)
            else:
                setattr(parent_package, leaf_name, previous_problem_attribute)
            world._state = previous_world_state
            world.build_domain_mesh = previous_build

        self.assertIs(world._state, previous_world_state)
        self.assertIs(world.build_domain_mesh, previous_build)
        if previous_scenario_module is missing:
            self.assertNotIn(scenario_module, sys.modules)
        else:
            self.assertIs(sys.modules[scenario_module], previous_scenario_module)
        if previous_problem_attribute is missing:
            self.assertFalse(hasattr(parent_package, leaf_name))
        else:
            self.assertIs(
                getattr(parent_package, leaf_name), previous_problem_attribute
            )

    def test_rejects_missing_phase_timing(self) -> None:
        document = _document()
        del document["runs"][0]["timings"]["gmsh_extract_s"]  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "gmsh_extract_s"):
            validate_evidence_document(document)

    def test_rejects_non_finite_timing(self) -> None:
        document = _document()
        document["runs"][0]["timings"]["gmsh_generate_s"] = math.inf  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "finite"):
            validate_evidence_document(document)

    def test_rejects_incomplete_summary(self) -> None:
        document = _document()
        del document["summary"]["timings"]["orientation_s"]  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "summary.*orientation_s"):
            validate_evidence_document(document)

    def test_rejects_non_finite_or_negative_summary_value(self) -> None:
        for value in (math.inf, -0.1):
            with self.subTest(value=value):
                document = _document()
                document["summary"]["timings"]["gmsh_repair_s"]["p95"] = value  # type: ignore[index]
                with self.assertRaisesRegex(ValueError, "summary.*p95"):
                    validate_evidence_document(document)

    def test_rejects_finite_summary_p95_that_does_not_match_runs(self) -> None:
        document = _document()
        document["summary"]["timings"]["total_s"]["p95"] = 0.002  # type: ignore[index]

        with self.assertRaisesRegex(ValueError, "summary.*runs"):
            validate_evidence_document(document)

    def test_summary_marks_unavailable_phase_and_rss_as_unavailable(self) -> None:
        runs = [_run("cold", memory_status="not_measured")]

        summary = benchmark._summarize(runs)

        self.assertIsNone(summary["timings"]["cache_lookup_s"])
        self.assertEqual(
            summary["timings"]["certificate_python_s"],
            {"p50": 0.001, "p95": 0.001, "max": 0.001},
        )
        self.assertIsNone(summary["python_audit_s"])
        self.assertIsNone(summary["peak_rss_bytes"])

    def test_summary_keeps_producer_certificate_timing_separate_from_python_audits(
        self,
    ) -> None:
        runs = [_run("cold"), _run("warm")]
        runs[0]["timings"]["certificate_python_s"] = 12.5  # type: ignore[index]
        runs[1]["timings"]["certificate_python_s"] = 12.5  # type: ignore[index]
        runs[0]["python_audit_samples_s"] = [0.1, 0.2, 0.3]
        runs[1]["python_audit_samples_s"] = [0.4, 0.5, 0.6]

        summary = benchmark._summarize(runs)

        self.assertEqual(
            summary["timings"]["certificate_python_s"],
            {"p50": 12.5, "p95": 12.5, "max": 12.5},
        )
        self.assertEqual(
            summary["python_audit_s"],
            {"p50": 0.35, "p95": 0.575, "max": 0.6},
        )

        document = _document()
        document["scenario"]["python_audit_runs"] = 3  # type: ignore[index]
        document["runs"] = runs
        document["summary"] = summary
        validate_evidence_document(document)

    def test_validator_requires_exact_declared_python_audit_sample_count_per_run(
        self,
    ) -> None:
        document = _document()
        document["scenario"]["python_audit_runs"] = 3  # type: ignore[index]
        for run in document["runs"]:  # type: ignore[union-attr]
            run["python_audit_samples_s"] = [0.1, 0.2, 0.3]
        document["summary"] = benchmark._summarize(document["runs"])  # type: ignore[arg-type]
        validate_evidence_document(document)

        for sample_count in (0, 1, 2):
            with self.subTest(sample_count=sample_count):
                incomplete = copy.deepcopy(document)
                incomplete["runs"][0]["python_audit_samples_s"] = [  # type: ignore[index]
                    0.1
                ] * sample_count
                with self.assertRaisesRegex(ValueError, "python_audit_samples_s"):
                    validate_evidence_document(incomplete)

    def test_quality_document_uses_certificate_plane_tolerance(self) -> None:
        certificate = SimpleNamespace(
            requested_layer_count=1,
            realized_layer_count=1,
            nonmanifold_face_count=0,
            plane_tolerance_m=2.5e-12,
            shared_domain_relative_volume_error=0.0,
            scaled_jacobian_p05_by_family={
                "prism6": 0.1,
                "pyramid5": 0.2,
                "tet4": 0.3,
            },
        )
        mesh = SimpleNamespace(mixed_layer_topology_certificate=certificate)

        with mock.patch(
            "fullmag.meshing._gmsh_types._mixed_same_side_two_owner_face_count",
            return_value=0,
        ) as count:
            quality = benchmark._quality_document(mesh)

        count.assert_called_once_with(mesh, tolerance=certificate.plane_tolerance_m)
        self.assertEqual(quality["same_side_two_owner_faces"], 0)

    def test_rejects_mixed_topology_fingerprint_across_warm_runs(self) -> None:
        document = _document()
        document["runs"] = [_run("warm", "a" * 64), _run("warm", "b" * 64)]
        with self.assertRaisesRegex(ValueError, "warm.*fingerprint"):
            validate_evidence_document(document)

    def test_compares_cold_quality_with_documented_binary64_tolerance(self) -> None:
        document = _document()
        allowed_delta = 16 * float.fromhex("0x1.0000000000000p-52")
        document["runs"] = [
            _run("cold", quality=_quality(relative_volume_error=0.0)),
            _run("cold", quality=_quality(relative_volume_error=allowed_delta)),
        ]
        validate_evidence_document(document)

        document["runs"][1]["quality"] = _quality(relative_volume_error=1.0e-9)  # type: ignore[index]
        with self.assertRaisesRegex(ValueError, "quality differs"):
            validate_evidence_document(document)

    def test_rejects_release_pass_with_failures(self) -> None:
        document = _document()
        document["gate"] = {"status": "release_pass", "failures": ["failed"]}
        with self.assertRaisesRegex(ValueError, "release_pass.*empty"):
            validate_evidence_document(document)

    def test_rejects_release_pass_when_rss_is_not_measured(self) -> None:
        document = _document()
        document["runs"][0] = _run("cold", memory_status="not_measured")  # type: ignore[index]
        document["gate"] = {"status": "release_pass", "failures": []}
        with self.assertRaisesRegex(ValueError, "release_pass.*RSS"):
            validate_evidence_document(document)

    def test_rejects_release_pass_when_any_run_is_degraded(self) -> None:
        document = _document()
        document["runs"][0] = _run("cold", degraded=True)  # type: ignore[index]
        document["gate"] = {"status": "release_pass", "failures": []}
        with self.assertRaisesRegex(ValueError, "release_pass.*degraded"):
            validate_evidence_document(document)

    def test_release_gate_recalculates_0105_quality_failures(self) -> None:
        cases = (
            (
                _quality(),
                "non-manifold",
                lambda quality: quality.__setitem__("non_manifold_faces", 1),
            ),
            (
                _quality(),
                "same-side",
                lambda quality: quality.__setitem__("same_side_two_owner_faces", 1),
            ),
            (
                _quality(relative_volume_error=1.1e-8),
                "volume",
                lambda _quality: None,
            ),
            (
                _quality(prism6=0.099),
                "p05",
                lambda _quality: None,
            ),
        )
        for quality, label, mutate in cases:
            with self.subTest(label=label):
                mutate(quality)
                document = _document()
                document["quality"] = copy.deepcopy(quality)
                document["runs"] = [_run("cold", quality=quality)]
                document["summary"] = _summary()
                document["gate"] = {"status": "release_pass", "failures": []}
                with self.assertRaisesRegex(ValueError, "gate.failures.*runs"):
                    validate_evidence_document(document)

    def test_release_gate_rejects_inexact_failure_list(self) -> None:
        quality = _quality(relative_volume_error=1.1e-8)
        document = _document()
        document["quality"] = copy.deepcopy(quality)
        document["runs"] = [_run("cold", quality=quality)]
        document["summary"] = _summary()
        document["gate"] = {
            "status": "release_fail",
            "failures": ["unrelated failure"],
        }

        with self.assertRaisesRegex(ValueError, "gate.failures.*runs"):
            validate_evidence_document(document)

    def test_computes_linear_interpolated_p95(self) -> None:
        self.assertEqual(benchmark.linear_percentile([0.0, 10.0], 0.95), 9.5)

    def test_benchmark_config_is_frozen(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            config = _config(Path(root_name))
            with self.assertRaises(FrozenInstanceError):
                config.cold_runs = 2  # type: ignore[misc]

    def test_config_requires_single_rayon_and_exactly_one_gmsh_thread(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            for field, value, message in (
                ("rayon_threads", (1, 2), "one Rayon"),
                ("gmsh_threads", (1, 2), "Gmsh.*exactly one"),
                ("gmsh_threads", (2,), "Gmsh.*exactly one"),
            ):
                with self.subTest(field=field, value=value):
                    config = _config(root, **{field: value})
                    with self.assertRaisesRegex(ValueError, message):
                        benchmark._validate_config(config, "baseline")

    def test_parser_rejects_matrix_and_noncanonical_gmsh_setting(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            common = [*_cli_args(root), "--mode", "baseline"]
            for thread_args in (
                ["--rayon-threads", "1,2", "--gmsh-threads", "1"],
                ["--rayon-threads", "1", "--gmsh-threads", "2"],
                ["--rayon-threads", "1", "--gmsh-threads", "1,2"],
            ):
                with self.subTest(thread_args=thread_args):
                    with contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit):
                            benchmark._parse_args([*common, *thread_args])

    def test_parser_preserves_literal_relocate3d_baseline_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            common = [*_cli_args(root), "--rayon-threads", "1", "--gmsh-threads", "1"]
            mode, config = benchmark._config_from_argv(
                [*common, "--mode", "qualification", "--repair-method", "default"]
            )
            self.assertEqual(mode, "qualification")
            self.assertEqual(config.repair_method_override, "")

            mode, config = benchmark._config_from_argv(
                [*common, "--mode", "qualification", "--repair-method", "Relocate3D"]
            )
            self.assertEqual(mode, "qualification")
            self.assertEqual(config.repair_method_override, "Relocate3D")

            mode, config = benchmark._config_from_argv(
                [*common, "--mode", "baseline", "--repair-method", "Relocate3D"]
            )
            self.assertEqual(mode, "baseline")
            self.assertIsNone(config.repair_method_override)

            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    benchmark._config_from_argv(
                        [*common, "--mode", "baseline", "--repair-method", "default"]
                    )

    def test_canonical_repair_is_measured_without_reimplementing_policy(self) -> None:
        calls: list[str] = []
        benchmark._execute_repair(
            repair_method_override=None,
            gmsh_api=object(),
            canonical_repair=lambda _gmsh: calls.append("canonical"),
            qualification_selector=None,
        )
        self.assertEqual(calls, ["canonical"])
        selected: list[tuple[str, object]] = []
        gmsh = object()
        benchmark._execute_repair(
            repair_method_override="Relocate3D",
            gmsh_api=gmsh,
            canonical_repair=lambda _gmsh: calls.append("wrong"),
            qualification_selector=lambda method, api: selected.append((method, api)),
        )
        self.assertEqual(selected, [("Relocate3D", gmsh)])
        self.assertEqual(calls, ["canonical"])
        with self.assertRaisesRegex(RuntimeError, "canonical qualification selector"):
            benchmark._execute_repair(
                repair_method_override="Relocate3D",
                gmsh_api=object(),
                canonical_repair=lambda _gmsh: calls.append("wrong"),
                qualification_selector=None,
            )

    def test_baseline_evidence_records_literal_relocate3d(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            dependencies = benchmark._BenchmarkDependencies(
                single_run=lambda **kwargs: (_run(str(kwargs["kind"])), _FakeMesh()),
                capture_source_identity=lambda _root: _source_identity(),
                environment=lambda _mesh: {
                    "python_version": "3.12.1",
                    "gmsh_version": "4.15.2",
                    "certifier_algorithm": "mixed_layer_topology_certificate.v1",
                    "platform": "Linux",
                    "cpu_model": "test cpu",
                    "logical_cpus": 1,
                },
            )

            document = benchmark._run_benchmark(
                _config(root, cold_runs=1, warm_runs=0),
                mode="baseline",
                dependencies=dependencies,
            )

            self.assertEqual(document["scenario"]["repair_method"], "Relocate3D")

    def test_qualification_executes_and_records_each_selected_repair_method(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            for repair_override, evidence_method in (
                ("", "default"),
                ("Relocate3D", "Relocate3D"),
                ("Netgen", "Netgen"),
            ):
                with self.subTest(repair_method=evidence_method):
                    mode, config = benchmark._config_from_argv(
                        [
                            *_cli_args(root),
                            "--mode",
                            "qualification",
                            "--repair-method",
                            evidence_method,
                            "--rayon-threads",
                            "1",
                            "--gmsh-threads",
                            "1",
                        ]
                    )
                    production_calls: list[object] = []
                    qualification_calls: list[tuple[str, object]] = []

                    def single_run(**kwargs: object) -> tuple[dict[str, object], object]:
                        gmsh = object()
                        benchmark._execute_repair(
                            repair_method_override=kwargs["repair_method_override"],  # type: ignore[arg-type]
                            gmsh_api=gmsh,
                            canonical_repair=production_calls.append,
                            qualification_selector=lambda method, api: qualification_calls.append(
                                (method, api)
                            ),
                        )
                        return _run(str(kwargs["kind"])), _FakeMesh()

                    dependencies = benchmark._BenchmarkDependencies(
                        single_run=single_run,
                        capture_source_identity=lambda _root: _source_identity(),
                        environment=lambda _mesh: {
                            "python_version": "3.12.1",
                            "gmsh_version": "4.15.2",
                            "certifier_algorithm": "mixed_layer_topology_certificate.v1",
                            "platform": "Linux",
                            "cpu_model": "test cpu",
                            "logical_cpus": 1,
                        },
                    )

                    document = benchmark._run_benchmark(
                        config,
                        mode=mode,
                        dependencies=dependencies,
                    )

                    self.assertEqual(production_calls, [])
                    self.assertEqual(len(qualification_calls), 1)
                    self.assertEqual(qualification_calls[0][0], repair_override)
                    self.assertEqual(
                        document["scenario"]["repair_method"], evidence_method
                    )

    def test_baseline_validator_rejects_noncanonical_repair_provenance(self) -> None:
        for method in ("default", "Netgen"):
            with self.subTest(method=method):
                document = _document()
                document["scenario"]["repair_method"] = method  # type: ignore[index]
                with self.assertRaisesRegex(
                    ValueError,
                    "baseline_recorded.*Relocate3D",
                ):
                    validate_evidence_document(document)

    def test_evidence_contract_has_a_dedicated_module_boundary(self) -> None:
        self.assertIsNotNone(
            importlib.util.find_spec("fem_mixed_mesh_benchmark_evidence")
        )

    def test_marks_unexecuted_native_certificate_phase_unavailable(self) -> None:
        self.assertEqual(
            benchmark._unavailable_phase_timings(native_audit_runs=0),
            ["cache_lookup_s", "certificate_native_s"],
        )
        self.assertEqual(
            benchmark._unavailable_phase_timings(native_audit_runs=1),
            ["cache_lookup_s"],
        )

    def test_artifact_hash_timing_includes_member_and_topology_verification(self) -> None:
        from fullmag.meshing._gmsh_types import MeshData

        timings_ns = {"artifact_hash_verify_s": 0}
        persistence = SimpleNamespace(
            sha256=hashlib.sha256,
            _deserialize_mesh=lambda payload: payload,
        )
        with mock.patch.object(
            MeshData,
            "topology_fingerprint_v3",
            return_value="sha256:" + "a" * 64,
        ):
            with mock.patch.object(
                benchmark.time,
                "perf_counter_ns",
                side_effect=(0, 5, 5, 16),
            ):
                with benchmark._persistence_phase_probe(timings_ns, persistence):
                    persistence.sha256(b"member")
                    MeshData.topology_fingerprint_v3(object())

        self.assertEqual(timings_ns["artifact_hash_verify_s"], 16)

    def test_full_harness_does_not_delete_shared_cache(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            root = Path(root_name)
            shared_cache = root / "shared-cache"
            shared_cache.mkdir()
            sentinel = shared_cache / "sentinel"
            sentinel.write_text("keep", encoding="utf-8")
            cold_workspaces: list[Path] = []
            config = _config(root, cold_runs=2, warm_runs=1)

            def single_run(**kwargs: object) -> tuple[dict[str, object], object]:
                workspace = Path(kwargs["workspace"])  # type: ignore[arg-type]
                self.assertEqual(
                    os.environ.get("FULLMAG_FEM_MESH_CACHE_DIR"),
                    str(shared_cache),
                )
                (workspace / "owned-by-harness").write_text("run", encoding="utf-8")
                if kwargs["kind"] == "cold":
                    workspace.relative_to(config.artifact_dir)
                    cold_workspaces.append(workspace)
                return _run(str(kwargs["kind"])), _FakeMesh()

            dependencies = benchmark._BenchmarkDependencies(
                single_run=single_run,
                capture_source_identity=lambda _root: _source_identity(),
                environment=lambda _mesh: {
                    "python_version": "3.12.1",
                    "gmsh_version": "4.15.2",
                    "certifier_algorithm": "mixed_layer_topology_certificate.v1",
                    "platform": "Linux",
                    "cpu_model": "test cpu",
                    "logical_cpus": 1,
                },
            )
            with mock.patch.dict(
                os.environ,
                {"FULLMAG_FEM_MESH_CACHE_DIR": str(shared_cache)},
            ):
                document = benchmark._run_benchmark(
                    config,
                    mode="baseline",
                    dependencies=dependencies,
                )
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
            self.assertTrue(cold_workspaces)
            self.assertTrue(all(not workspace.exists() for workspace in cold_workspaces))
            self.assertEqual(document["gate"]["status"], "baseline_recorded")  # type: ignore[index]

    def test_real_run_environment_isolates_without_deleting_shared_cache(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            shared_cache = Path(root_name) / "shared-cache"
            shared_cache.mkdir()
            sentinel = shared_cache / "sentinel"
            sentinel.write_text("keep", encoding="utf-8")

            with mock.patch.dict(
                os.environ,
                {"FULLMAG_FEM_MESH_CACHE_DIR": str(shared_cache)},
            ):
                with benchmark._isolated_run_environment(
                    rayon_threads=1,
                    gmsh_threads=1,
                ):
                    self.assertEqual(
                        os.environ.get("FULLMAG_FEM_MESH_CACHE_DIR"),
                        "",
                    )
                    self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

                self.assertEqual(
                    os.environ.get("FULLMAG_FEM_MESH_CACHE_DIR"),
                    str(shared_cache),
                )
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    def test_json_writer_validator_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as root_name:
            path = Path(root_name) / "evidence.json"
            benchmark._write_document(path, _document())
            payload = path.read_text(encoding="utf-8")
            self.assertTrue(payload.endswith("\n"))
            loaded = json.loads(payload)
            validate_evidence_document(loaded)
            self.assertEqual(payload, benchmark._render_document(loaded))

    def test_baseline_mode_never_claims_release_pass(self) -> None:
        gate = benchmark.make_gate("baseline", [])
        self.assertEqual(gate, {"status": "baseline_recorded", "failures": []})
        self.assertNotEqual(gate["status"], "release_pass")


def _cli_args(root: Path) -> list[str]:
    return [
        "--scenario", "sp4_mixed",
        "--cold-runs", "1",
        "--warm-runs", "0",
        "--native-audit-runs", "0",
        "--python-audit-runs", "0",
        "--warmup-runs", "0",
        "--artifact-dir", str(root.resolve()),
        "--output", str((root / "evidence.json").resolve()),
    ]


if __name__ == "__main__":
    unittest.main()
