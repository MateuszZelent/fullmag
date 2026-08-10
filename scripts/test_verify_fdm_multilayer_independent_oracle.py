from __future__ import annotations

import csv
import json
import math
import tempfile
import unittest
from pathlib import Path

from scripts.verify_fdm_multilayer_independent_oracle import (
    MU0,
    OracleError,
    RuntimeArtifact,
    RuntimeLayer,
    _field_from_layers,
    _field_values_numpy,
    cubature_cell_pair_tensor,
    independent_newell_tensor,
    verify_bundle,
    verify_runtime_artifact,
)
from scripts.verify_fdm_multilayer_transfer_parity import (
    TransferGeometry,
    _adjoint_report,
    _overlap_stencil,
    _pull_adjoint,
    _push_values,
    _scratch_field,
    _scratch_fields_numpy,
)


QUALIFICATION_SCOPE = "SP4-derived, not canonical SP4 qualification"


def _layer_entry(
    name: str,
    grid: tuple[int, int, int],
    cell: tuple[float, float, float],
    origin: tuple[float, float, float],
    offset: int,
    transfer_kind: str = "identity",
) -> dict[str, object]:
    count = math.prod(grid)
    return {
        "magnet_name": name,
        "native_grid": list(grid),
        "native_cell_size": list(cell),
        "native_origin": list(origin),
        "convolution_grid": list(grid),
        "convolution_cell_size": list(cell),
        "transfer_kind": transfer_kind,
        "active_mask_present": False,
        "active_cell_count": count,
        "inactive_cell_count": 0,
        "value_offset": offset,
        "value_count": count,
    }


def _manifest_layer(entry: dict[str, object], directory: str) -> dict[str, object]:
    return {
        "id": entry["magnet_name"],
        "directory": directory,
        "file_pattern": f"{directory}/step_{{step:06}}.json",
        "native_grid": entry["native_grid"],
        "native_cell_size": entry["native_cell_size"],
        "native_origin": entry["native_origin"],
        "convolution_grid": entry["convolution_grid"],
        "convolution_cell_size": entry["convolution_cell_size"],
        "transfer_kind": entry["transfer_kind"],
        "active_mask_present": False,
        "active_cell_count": entry["active_cell_count"],
        "inactive_cell_count": 0,
        "value_offset": entry["value_offset"],
        "value_count": entry["value_count"],
        "vector_shape": [entry["value_count"], 3],
    }


def _cell_centers(
    grid: tuple[int, int, int],
    cell: tuple[float, float, float],
    origin: tuple[float, float, float],
) -> list[tuple[float, float, float]]:
    nx, ny, nz = grid
    return [
        (
            origin[0] + (x + 0.5) * cell[0],
            origin[1] + (y + 0.5) * cell[1],
            origin[2] + (z + 0.5) * cell[2],
        )
        for z in range(nz)
        for y in range(ny)
        for x in range(nx)
    ]


def _write_runtime_artifact(
    root: Path,
    layers: list[dict[str, object]],
    magnetizations: list[list[tuple[float, float, float]]],
) -> None:
    root.mkdir(parents=True)
    (root / "fields" / "H_demag").mkdir(parents=True)
    layout_layers = [_layer_entry(**layer) for layer in layers]
    layout = {
        "backend": "fdm_multilayer",
        "mode": "two_d_stack",
        "common_cells": [1, 1, 1],
        "layer_count": len(layout_layers),
        "layers": layout_layers,
        "planner_summary": {"requested_strategy": "multilayer_convolution"},
    }
    manifest_layers = []
    for index, entry in enumerate(layout_layers):
        manifest_layers.append(_manifest_layer(entry, f"layer-{index}"))

    expected_fields: list[list[tuple[float, float, float]]] = [
        [] for _ in layout_layers
    ]
    for target_index, target in enumerate(layout_layers):
        target_grid = tuple(target["native_grid"])
        target_cell = tuple(target["native_cell_size"])
        target_origin = tuple(target["native_origin"])
        target_centers = _cell_centers(target_grid, target_cell, target_origin)
        for destination in target_centers:
            field = [0.0, 0.0, 0.0]
            for source_index, source in enumerate(layout_layers):
                source_grid = tuple(source["native_grid"])
                source_cell = tuple(source["native_cell_size"])
                source_origin = tuple(source["native_origin"])
                for source_cell_index, source_center in enumerate(
                    _cell_centers(source_grid, source_cell, source_origin)
                ):
                    displacement = tuple(
                        destination[axis] - source_center[axis] for axis in range(3)
                    )
                    tensor = independent_newell_tensor(
                        source_cell,
                        target_cell,
                        displacement,
                    )
                    magnetization = magnetizations[source_index][source_cell_index]
                    field[0] -= tensor[0] * magnetization[0]
                    field[0] -= tensor[3] * magnetization[1]
                    field[0] -= tensor[4] * magnetization[2]
                    field[1] -= tensor[3] * magnetization[0]
                    field[1] -= tensor[1] * magnetization[1]
                    field[1] -= tensor[5] * magnetization[2]
                    field[2] -= tensor[4] * magnetization[0]
                    field[2] -= tensor[5] * magnetization[1]
                    field[2] -= tensor[2] * magnetization[2]
            expected_fields[target_index].append(tuple(field))

    runtime_metadata = {
        "scenario_id": "independent_oracle_test_runtime",
        "qualification_scope": QUALIFICATION_SCOPE,
        "runtime_qualification": "runtime_artifact",
        "backend": "fdm",
        "device": "cpu",
        "precision": "double",
    }
    metadata = {
        "problem_name": "independent_oracle_test",
        "source_hash": "test-runtime-source-hash",
        "status": "completed",
        "engine_version": "test-runtime",
        "problem_meta": {"runtime_metadata": {"fdm_multilayer_qualification": runtime_metadata}},
        "pbc": None,
        "requested_execution": {
            "backend": "fdm",
            "device": "cpu",
            "precision": "double",
            "fallback_policy": "forbidden",
        },
        "artifact_layout": layout,
        "mesh": {
            "backend": "fdm_multilayer",
            "periodic_axes": [False, False, False],
            "transfer_boundary_policy": ["open", "open", "open"],
        },
        "execution_provenance": {
            "execution_engine": "cpu_reference_multilayer",
            "precision": "double",
            "demag_operator_kind": "multilayer_tensor_fft_newell",
            "lossy_fallback_used": False,
        },
        "execution_plan": {
            "backend_plan": {
                "layers": [
                    {
                        "magnet_name": entry["magnet_name"],
                        "material": {"saturation_magnetisation": 1.0},
                    }
                    for entry in layout_layers
                ]
            }
        },
        "accepted_solver_steps": 0,
    }
    (root / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")

    initial_values = [value for values in magnetizations for value in values]
    (root / "m_initial.json").write_text(
        json.dumps(
            {
                "observable": "m",
                "unit": "1",
                "step": 0,
                "time": 0.0,
                "layout": layout,
                "values": initial_values,
            }
        ),
        encoding="utf-8",
    )
    (root / "fields" / "H_demag" / "manifest.json").write_text(
        json.dumps(
            {
                "schema_version": "fdm_multilayer_field_manifest.v1",
                "observable": "H_demag",
                "unit": "A/m",
                "storage_layout": "per_layer_json",
                "component_order": ["x", "y", "z"],
                "layer_count": len(manifest_layers),
                "layers": manifest_layers,
                "layout": layout,
            }
        ),
        encoding="utf-8",
    )
    total_energy = 0.0
    with (root / "scalars.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(
            stream,
            fieldnames=["step", "time", "E_demag"],
        )
        writer.writeheader()
        for target_index, values in enumerate(expected_fields):
            target = layout_layers[target_index]
            volume = math.prod(tuple(target["native_cell_size"]))
            for magnetization, field in zip(magnetizations[target_index], values):
                total_energy += -0.5 * MU0 * volume * sum(
                    magnetization[axis] * field[axis] for axis in range(3)
                )
        writer.writerow({"step": 0, "time": 0.0, "E_demag": total_energy})
    for index, (entry, values) in enumerate(zip(manifest_layers, expected_fields)):
        layer_dir = root / "fields" / "H_demag" / str(entry["directory"])
        layer_dir.mkdir(parents=True)
        (layer_dir / "step_000000.json").write_text(
            json.dumps(
                {
                    "observable": "H_demag",
                    "unit": "A/m",
                    "step": 0,
                    "time": 0.0,
                    "component_count": 3,
                    "component_order": "xyz",
                    "location": "cell",
                    "scope": "layer",
                    "revision": 1,
                    "layer": entry,
                    "layout": layout,
                    "provenance": metadata["execution_provenance"],
                    "values": values,
                }
            ),
            encoding="utf-8",
        )


class IndependentOracleTests(unittest.TestCase):
    def test_numpy_lag_sweep_matches_direct_for_unequal_z_cell_counts(self) -> None:
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy is optional outside the managed runtime")
        layers = [
            RuntimeLayer(
                name="bottom",
                grid=(2, 1, 1),
                cell=(1.0, 1.0, 1.0),
                origin=(0.0, 0.0, 0.0),
                transfer_kind="identity",
                saturation_magnetisation=1.0,
                magnetization=[(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)],
                field=[(0.0, 0.0, 0.0)] * 2,
                active=[True, True],
            ),
            RuntimeLayer(
                name="top",
                grid=(2, 1, 2),
                cell=(1.0, 1.0, 1.0),
                origin=(0.0, 0.0, 3.0),
                transfer_kind="identity",
                saturation_magnetisation=1.0,
                magnetization=[(0.0, 0.0, 1.0)] * 4,
                field=[(0.0, 0.0, 0.0)] * 4,
                active=[True] * 4,
            ),
        ]
        artifact = RuntimeArtifact(Path("synthetic-unequal"), {}, layers, 0, 0.0, "l2_unequal_thickness")
        fast = _field_values_numpy(artifact, {})
        for target_index, target in enumerate(layers):
            for cell_index in range(target.count):
                direct = _field_from_layers(target, cell_index, layers, {})
                for actual, expected in zip(fast[target_index][cell_index], direct):
                    self.assertAlmostEqual(actual, expected, places=11)

    def test_numpy_lag_sweep_matches_direct_scratch_field(self) -> None:
        try:
            import numpy  # noqa: F401
        except ImportError:
            self.skipTest("numpy is optional outside the managed runtime")
        geometry = TransferGeometry(
            native_grid=(2, 1, 1),
            native_cell=(1.0, 1.0, 1.0),
            native_origin=(0.0, 0.0, 0.0),
            scratch_grid=(2, 1, 1),
            scratch_cell=(1.0, 1.0, 1.0),
            scratch_origin=(0.0, 0.0, 0.0),
        )
        layers = [
            RuntimeLayer(
                name="layer0",
                grid=(2, 1, 1),
                cell=(1.0, 1.0, 1.0),
                origin=(0.0, 0.0, 0.0),
                transfer_kind="push_pull",
                saturation_magnetisation=1.0,
                magnetization=[(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)],
                field=[(0.0, 0.0, 0.0)] * 2,
                active=[True, True],
            )
        ]
        artifact = RuntimeArtifact(Path("synthetic"), {}, layers, 0, 0.0, "l1_self")
        pushed = [[(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]]
        tensor_cache: dict[tuple[object, ...], tuple[float, ...]] = {}
        fast = _scratch_fields_numpy(0, artifact, [geometry], pushed, tensor_cache)
        direct = [
            _scratch_field(0, index, artifact, [geometry], pushed, tensor_cache)
            for index in range(geometry.scratch_count)
        ]
        for fast_value, direct_value in zip(fast, direct):
            for actual, expected in zip(fast_value, direct_value):
                self.assertAlmostEqual(actual, expected, places=12)

    def test_volume_weighted_push_pull_is_an_exact_adjoint(self) -> None:
        geometry = TransferGeometry(
            native_grid=(2, 1, 1),
            native_cell=(1.0, 1.0, 1.0),
            native_origin=(0.0, 0.0, 0.0),
            scratch_grid=(1, 1, 1),
            scratch_cell=(2.0, 1.0, 1.0),
            scratch_origin=(0.0, 0.0, 0.0),
        )
        stencil = _overlap_stencil(geometry)
        pushed, covered = _push_values([(1.0, 0.0, 0.0), (3.0, 0.0, 0.0)], geometry, stencil)
        self.assertEqual(pushed, [(2.0, 0.0, 0.0)])
        self.assertEqual(covered, [2.0])
        pulled = _pull_adjoint([(5.0, -2.0, 1.0)], geometry, stencil, covered)
        self.assertEqual(pulled, [(5.0, -2.0, 1.0), (5.0, -2.0, 1.0)])
        scratch_test = [[(0.25, -0.5, 0.75)]]
        pulled_test = [_pull_adjoint(scratch_test[0], geometry, stencil, covered)]
        report = _adjoint_report(
            [[(1.0, 0.0, 0.0), (3.0, 0.0, 0.0)]],
            [pushed],
            scratch_test,
            pulled_test,
            [geometry],
        )
        self.assertEqual(report["status"], "pass")

    def test_self_cube_has_one_third_diagonal_factors(self) -> None:
        tensor = independent_newell_tensor((1.0, 1.0, 1.0), (1.0, 1.0, 1.0), (0.0, 0.0, 0.0))
        for value in tensor[3:]:
            self.assertAlmostEqual(value, 0.0, places=16)
        for value in tensor[:3]:
            self.assertAlmostEqual(value, 1.0 / 3.0, places=13)
        self.assertAlmostEqual(sum(tensor[:3]), 1.0, places=13)

    def test_unequal_cell_cubature_cross_checks_independent_newell(self) -> None:
        source = (0.7, 0.9, 1.1)
        destination = (0.8, 1.2, 0.5)
        displacement = (0.3, -0.2, 2.0)
        newell = independent_newell_tensor(source, destination, displacement)
        cubature = cubature_cell_pair_tensor(source, destination, displacement)
        for actual, expected in zip(newell, cubature):
            self.assertAlmostEqual(actual, expected, delta=5.0e-10)

    def test_independent_newell_enforces_signed_lag_parity(self) -> None:
        positive = independent_newell_tensor(
            (1.0, 1.0, 1.0), (1.0, 1.0, 1.0), (117.0, 2.0, 0.0)
        )
        negative = independent_newell_tensor(
            (1.0, 1.0, 1.0), (1.0, 1.0, 1.0), (-117.0, -2.0, 0.0)
        )
        for actual, reference in zip(negative, positive):
            self.assertAlmostEqual(actual, reference, delta=1.0e-12)

    def test_missing_runtime_provenance_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            root.mkdir(exist_ok=True)
            (root / "metadata.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(OracleError, "(status|execution_provenance)"):
                verify_runtime_artifact(root)

    def test_push_pull_artifact_is_not_checked_as_identity_oracle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "push-pull"
            _write_runtime_artifact(
                root,
                [
                    {
                        "name": "layer0",
                        "grid": (1, 1, 1),
                        "cell": (1.0, 1.0, 1.0),
                        "origin": (0.0, 0.0, 0.0),
                        "offset": 0,
                        "transfer_kind": "push_pull",
                    }
                ],
                [[(1.0, 0.0, 0.0)]],
            )
            with self.assertRaisesRegex(OracleError, "identity transfer"):
                verify_runtime_artifact(root)

    def test_fresh_one_layer_artifact_reports_field_energy_and_self(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "l1"
            _write_runtime_artifact(
                root,
                [
                    {
                        "name": "layer0",
                        "grid": (1, 1, 1),
                        "cell": (1.0, 1.0, 1.0),
                        "origin": (0.0, 0.0, 0.0),
                        "offset": 0,
                    }
                ],
                [[(1.0, 0.0, 0.0)]],
            )
            report = verify_runtime_artifact(root)
            self.assertEqual(report["case"], "l1_self")
            self.assertEqual(report["qualification_status"], "qualified")
            self.assertEqual(report["field_norm"]["status"], "pass")
            self.assertEqual(report["energy_norm"]["status"], "pass")
            self.assertEqual(report["reciprocity"]["status"], "pass")

    def test_two_layer_artifacts_cover_signed_z_and_unequal_thickness(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            equal = root / "l2-equal"
            _write_runtime_artifact(
                equal,
                [
                    {"name": "bottom", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 0.0), "offset": 0},
                    {"name": "top", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 3.0), "offset": 1},
                ],
                [[(1.0, 0.0, 0.0)], [(0.0, 1.0, 0.0)]],
            )
            unequal = root / "l2-unequal"
            _write_runtime_artifact(
                unequal,
                [
                    {"name": "bottom", "grid": (1, 1, 1), "cell": (1.0, 1.0, 0.5), "origin": (0.0, 0.0, 0.0), "offset": 0},
                    {"name": "top", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.5), "origin": (0.0, 0.0, 3.0), "offset": 1},
                ],
                [[(1.0, 0.0, 0.0)], [(0.0, 1.0, 0.0)]],
            )
            equal_report = verify_runtime_artifact(equal)
            unequal_report = verify_runtime_artifact(unequal)
            self.assertEqual(equal_report["case"], "l2_equal_thickness")
            self.assertTrue(equal_report["reciprocity"]["orientation"]["both_signed_directions"])
            self.assertEqual(equal_report["qualification_status"], "qualified")
            self.assertEqual(unequal_report["case"], "l2_unequal_thickness")
            self.assertEqual(unequal_report["cubature_crosscheck"]["status"], "pass")
            self.assertEqual(unequal_report["qualification_status"], "qualified")

    def test_three_equal_layers_are_a_qualified_l3_regular_case(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "l3-regular"
            _write_runtime_artifact(
                root,
                [
                    {"name": "bottom", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 0.0), "offset": 0},
                    {"name": "middle", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 3.0), "offset": 1},
                    {"name": "top", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 6.0), "offset": 2},
                ],
                [[(1.0, 0.0, 0.0)], [(0.0, 1.0, 0.0)], [(0.0, 0.0, 1.0)]],
            )

            report = verify_runtime_artifact(root)

            self.assertEqual(report["case"], "l3_regular")
            self.assertEqual(report["qualification_status"], "qualified")
            self.assertTrue(report["reciprocity"]["orientation"]["both_signed_directions"])

    def test_l3_only_bundle_is_qualified_without_claiming_l1_or_l2_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "l3-regular"
            _write_runtime_artifact(
                root,
                [
                    {"name": "bottom", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 0.0), "offset": 0},
                    {"name": "middle", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 3.0), "offset": 1},
                    {"name": "top", "grid": (1, 1, 1), "cell": (1.0, 1.0, 1.0), "origin": (0.0, 0.0, 6.0), "offset": 2},
                ],
                [[(1.0, 0.0, 0.0)], [(0.0, 1.0, 0.0)], [(0.0, 0.0, 1.0)]],
            )

            report = verify_bundle([root])

            self.assertEqual(report["qualification_status"], "qualified")
            self.assertEqual(report["coverage"], {"l3_regular": True})

    def test_cubature_skips_touching_same_layer_cells(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "same-layer-touching"
            _write_runtime_artifact(
                root,
                [
                    {
                        "name": "layer0",
                        "grid": (2, 1, 1),
                        "cell": (1.0, 1.0, 1.0),
                        "origin": (0.0, 0.0, 0.0),
                        "offset": 0,
                    }
                ],
                [[(1.0, 0.0, 0.0), (0.0, 1.0, 0.0)]],
            )
            report = verify_runtime_artifact(root)
            self.assertEqual(report["cubature_crosscheck"]["status"], "not_applicable")
            self.assertEqual(report["qualification_status"], "qualified")


if __name__ == "__main__":
    unittest.main()
