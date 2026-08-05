#!/usr/bin/env python3
"""Regression tests for the SP5 FEM/FDM field-comparison time gate."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.compare_sp5_field_states import compare


_CUBE_NODES = [
    [0.0, 0.0, 0.0],
    [1.0, 0.0, 0.0],
    [1.0, 1.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
    [1.0, 0.0, 1.0],
    [1.0, 1.0, 1.0],
    [0.0, 1.0, 1.0],
]
_CUBE_TETS = [
    [0, 1, 2, 6],
    [0, 2, 3, 6],
    [0, 4, 5, 6],
    [0, 5, 1, 6],
    [0, 3, 7, 6],
    [0, 7, 4, 6],
]


def _write_runs(root: Path, *, fdm_time: float, fem_time: float) -> tuple[Path, Path]:
    fdm = root / "fdm"
    fdm.mkdir()
    (fdm / "m_final.json").write_text(
        json.dumps(
            {
                "time": fdm_time,
                "values": [[1.0, 0.0, 0.0]],
                "layout": {
                    "backend": "fdm",
                    "grid_cells": [1, 1, 1],
                    "cell_size": [1.0, 1.0, 1.0],
                    "origin_m": [0.0, 0.0, 0.0],
                    "active_mask": [True],
                },
            }
        ),
        encoding="utf-8",
    )

    fem = root / "fem"
    fem.mkdir()
    (fem / "m_final.json").write_text(
        json.dumps(
            {
                "time": fem_time,
                "values": [[1.0, 0.0, 0.0] for _ in _CUBE_NODES],
                "layout": {"backend": "fem"},
            }
        ),
        encoding="utf-8",
    )
    cells = [node for tetrahedron in _CUBE_TETS for node in tetrahedron]
    mesh = {
        "nodes": _CUBE_NODES,
        "cells": {
            "types": ["tet4"] * len(_CUBE_TETS),
            "offsets": [4 * index for index in range(len(_CUBE_TETS) + 1)],
            "nodes": cells,
            "global_ordinals": list(range(len(_CUBE_TETS))),
            "mesh_parts": ["magnetic"] * len(_CUBE_TETS),
        },
        "element_markers": [1] * len(_CUBE_TETS),
        "facets": {
            "types": [],
            "roles": [],
            "offsets": [0],
            "nodes": [],
            "global_ordinals": [],
        },
        "boundary_markers": [],
    }
    (fem / "metadata.json").write_text(
        json.dumps({"execution_plan": {"backend_plan": {"mesh": mesh}}}),
        encoding="utf-8",
    )
    return fdm, fem


class CompareSp5FieldStatesTest(unittest.TestCase):
    def test_mismatched_final_times_are_rejected_for_qualification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fdm, fem = _write_runs(Path(directory), fdm_time=1.0, fem_time=2.0)

            report = compare(fdm, fem, time_tolerance=1.0e-12)

        self.assertFalse(report["same_final_time"])
        self.assertEqual(report["qualification"]["status"], "rejected")
        self.assertFalse(report["qualification"]["equivalence_established"])
        self.assertIn("final physical times", report["qualification"]["reason"])

    def test_matched_final_times_remain_diagnostic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            fdm, fem = _write_runs(Path(directory), fdm_time=1.0, fem_time=1.0)

            report = compare(fdm, fem, time_tolerance=1.0e-12)

        self.assertTrue(report["same_final_time"])
        self.assertEqual(report["qualification"]["status"], "diagnostic")
        self.assertFalse(report["qualification"]["equivalence_established"])


if __name__ == "__main__":
    unittest.main()
