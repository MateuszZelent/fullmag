from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

from scripts.test_verify_fdm_multilayer_independent_oracle import _write_runtime_artifact
from scripts.verify_fdm_multilayer_independent_oracle import OracleError
from scripts.verify_fdm_multilayer_transfer_parity import (
    TransferGeometry,
    _adjoint_report,
    _adjoint_test_vectors,
    _overlap_stencil,
    _pull_adjoint,
    _push_values,
    verify_transfer_artifact,
)


def _write_push_pull_fixture(root: Path) -> None:
    layers: list[dict[str, object]] = [
        {
            "name": "bottom",
            "grid": (1, 1, 1),
            "cell": (1.0, 1.0, 1.0),
            "origin": (0.0, 0.0, 0.0),
            "offset": 0,
            "transfer_kind": "push_pull",
        },
        {
            "name": "top",
            "grid": (1, 1, 1),
            "cell": (1.0, 1.0, 1.0),
            "origin": (0.0, 0.0, 3.0),
            "offset": 1,
            "transfer_kind": "push_pull",
        },
    ]
    _write_runtime_artifact(
        root,
        layers,
        [[(1.0, 0.0, 0.0)], [(0.0, 1.0, 0.0)]],
    )
    metadata_path = root / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    layout_layers = metadata["artifact_layout"]["layers"]
    for layer in layout_layers:
        layer["convolution_origin"] = layer["native_origin"]
    metadata["execution_provenance"]["fdm_multilayer_transfer"] = {
        "schema_version": "fdm_multilayer_transfer_realization.v1",
        "realization": "volume_weighted_overlap_adjoint",
        "layers": [
            {
                "magnet_name": layer["magnet_name"],
                "transfer_kind": layer["transfer_kind"],
            }
            for layer in layout_layers
        ],
    }
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    mesh_transfers = []
    for index, layer in enumerate(layout_layers):
        mesh_transfers.append(
            {
                "magnet_name": layer["magnet_name"],
                "transfer_kind": "push_pull",
                "source_grid_fingerprint": f"{index + 1:x}" * 64,
                "target_grid_fingerprint": "a" * 64,
                "periodic_axes": [False, False, False],
                "boundary_policy": ["open", "open", "open"],
                "source_grid": {
                    "cells": layer["native_grid"],
                    "cell_m": layer["native_cell_size"],
                    "origin_m": layer["native_origin"],
                },
                "target_grid": {
                    "cells": layer["convolution_grid"],
                    "cell_m": layer["convolution_cell_size"],
                    "origin_m": [0.0, 0.0, 0.0],
                },
            }
        )
    mesh = {
        "schema_version": "fdm_transfer_provenance.v1",
        "backend": "fdm_multilayer",
        "target_grid_fingerprint": "a" * 64,
        "periodic_axes": [False, False, False],
        "boundary_policy": ["open", "open", "open"],
        "transfers": mesh_transfers,
    }
    mesh_path = root / "mesh" / "fdm_transfer_provenance.v1.json"
    mesh_path.parent.mkdir(parents=True, exist_ok=True)
    mesh_path.write_text(json.dumps(mesh), encoding="utf-8")


class TransferParityTests(unittest.TestCase):
    def test_adjoint_residual_uses_two_nonuniform_probes_and_rejects_bad_pull(self) -> None:
        geometry = TransferGeometry(
            native_grid=(2, 1, 1),
            native_cell=(1.0, 1.0, 1.0),
            native_origin=(0.0, 0.0, 0.0),
            scratch_grid=(4, 1, 1),
            scratch_cell=(0.5, 1.0, 1.0),
            scratch_origin=(0.0, 0.0, 0.0),
        )
        native_values = [[(1.0, 0.2, -0.4), (-0.7, 0.6, 0.9)]]
        stencil = _overlap_stencil(geometry)
        pushed, covered = _push_values(native_values[0], geometry, stencil)
        probes = _adjoint_test_vectors([geometry])

        self.assertEqual(len(probes), 2)
        self.assertNotEqual(probes[0], probes[1])
        for probe in probes:
            self.assertGreater(len({tuple(value) for value in probe[0]}), 1)
            pulled = [_pull_adjoint(probe[0], geometry, stencil, covered)]
            report = _adjoint_report(native_values, [pushed], probe, pulled, [geometry])
            self.assertEqual(report["status"], "pass")

        bad_pulled = [_pull_adjoint(probes[0][0], geometry, stencil, covered)]
        bad_pulled[0].reverse()
        bad_report = _adjoint_report(
            native_values,
            [pushed],
            probes[0],
            bad_pulled,
            [geometry],
        )
        self.assertEqual(bad_report["status"], "fail")
        self.assertGreater(bad_report["abs_residual"], bad_report["tolerance"])

    def test_qualified_fixture_reports_both_adjoint_probes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "valid"
            _write_push_pull_fixture(root)

            report = verify_transfer_artifact(root, max_target_cells=4, max_energy_cells=4)

            self.assertEqual(report["qualification_status"], "qualified")
            self.assertEqual(report["transfer_adjoint"]["vector_case_count"], 2)
            self.assertTrue(all(case["status"] == "pass" for case in report["transfer_adjoint"]["vector_cases"]))

    def test_transfer_provenance_is_bound_to_layout_and_mesh(self) -> None:
        mutations: list[tuple[str, Callable[[Path], None], str]] = [
            (
                "execution-layer-name",
                lambda root: _mutate_json(
                    root / "metadata.json",
                    lambda payload: payload["execution_provenance"]["fdm_multilayer_transfer"]["layers"][1].update(
                        {"magnet_name": "forged-top"}
                    ),
                ),
                "execution transfer provenance layer 1 does not match artifact_layout",
            ),
            (
                "mesh-source-grid",
                lambda root: _mutate_json(
                    root / "mesh" / "fdm_transfer_provenance.v1.json",
                    lambda payload: payload["transfers"][0]["source_grid"]["cells"].__setitem__(0, 99),
                ),
                "mesh transfer provenance layer 0 source grid does not match artifact_layout",
            ),
            (
                "mesh-target-fingerprint",
                lambda root: _mutate_json(
                    root / "mesh" / "fdm_transfer_provenance.v1.json",
                    lambda payload: payload["transfers"][1].update({"target_grid_fingerprint": "b" * 64}),
                ),
                "mesh transfer provenance layer 1 target fingerprint mismatch",
            ),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            for name, mutate, message in mutations:
                root = Path(tmp) / name
                _write_push_pull_fixture(root)
                mutate(root)
                with self.subTest(name=name), self.assertRaisesRegex(OracleError, message):
                    verify_transfer_artifact(root, max_target_cells=4, max_energy_cells=4)


def _mutate_json(path: Path, mutation: Callable[[dict[str, Any]], None]) -> None:
    payload = json.loads(path.read_text(encoding="utf-8"))
    mutation(payload)
    path.write_text(json.dumps(payload), encoding="utf-8")


if __name__ == "__main__":
    unittest.main()
