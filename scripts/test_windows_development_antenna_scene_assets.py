from __future__ import annotations

import copy
import unittest
from typing import Any

from windows.development_scene_assets import (
    SceneAssetError,
    collect_scene_assets,
    _rebase_declared_scene_assets,
)


def empty_scene() -> dict[str, Any]:
    return {
        "version": "scene.v2",
        "objects": [],
        "materials": [],
        "magnetization_assets": [],
        "study": {},
        "outputs": {"items": []},
    }


def valid_antenna_scene() -> dict[str, Any]:
    scene = empty_scene()
    scene.update(
        {
            "antenna_port_modes": [
                {
                    "schema_version": "antenna_port_mode.v2",
                    "id": "port-1",
                    "source_object_id": "signal-body",
                    "current_transport_id": "transport-1",
                    "branches": [
                        {
                            "id": "signal",
                            "inlet_terminal_ref": "signal-in",
                            "outlet_terminal_ref": "signal-out",
                            "signed_weight": 1.0,
                        },
                        {
                            "id": "return",
                            "inlet_terminal_ref": "return-in",
                            "outlet_terminal_ref": "return-out",
                            "signed_weight": -1.0,
                        },
                    ],
                    # normalization_current_a has a serde default.
                }
            ],
            "antenna_field_solve_stages": [
                {
                    "id": "solve-1",
                    "source_object_id": "signal-body",
                    "current_transport_id": "transport-1",
                    "port_mode_ids": ["port-1"],
                    "conservative_current_view_ref": None,
                    "model": "quasistatic_conduction_biot_savart3d",
                    "oersted_realization": "direct_tetra_quadrature",
                    "conductor_mesh_policy": "authored_shared_domain",
                    "field_sampling_domain": {"kind": "global"},
                    "target_refs": [
                        {"kind": "object", "object_id": "magnetic-body"},
                        {"kind": "region", "object_id": "magnetic-body", "region_id": "film"},
                    ],
                    "solver_policy": "production_default",
                    "outputs": [{"id": "basis", "quantity": "H_ant_basis"}],
                }
            ],
            "antenna_target_projections": [
                {
                    "id": "projection-stage-output",
                    "solution": {"kind": "stage_output", "stage_id": "solve-1", "output_id": "basis"},
                    "target": {"kind": "global"},
                    "output_id": "basis",
                },
                {
                    "id": "projection-resolved-asset",
                    "solution": {
                        "kind": "resolved_asset",
                        "stage_id": "solve-1",
                        "output_id": "basis",
                        "asset_id": "antenna-solution-resolved",
                        "content_digest": "sha256:resolved",
                    },
                    "target": {"kind": "object", "object_id": "magnetic-body"},
                    "output_id": "basis",
                },
                {
                    "id": "projection-published",
                    "solution": {
                        "stage_id": "solve-1",
                        "output_id": "basis",
                        "asset_id": "antenna-solution-published",
                        "content_digest": "sha256:published",
                    },
                    "target": {"kind": "region", "object_id": "magnetic-body", "region_id": "film"},
                    "output_id": "basis",
                },
            ],
            "solved_antenna_drives": [
                {
                    "id": f"drive-{index}",
                    "name": f"Drive {index}",
                    "projection_ref": "projection-stage-output",
                    "port_mode_id": "port-1",
                    "peak_current_a": 1.0,
                    "waveform": waveform,
                    "time_origin": "stage_local" if index % 2 == 0 else "absolute",
                    "activation": (
                        {"kind": "all_time_evolution"}
                        if index % 2 == 0
                        else {"kind": "stage_ids", "stage_ids": ["stage-1"]}
                    ),
                    **(
                        {"bandwidth_declaration": {"f_max_hz": 1.0e9}}
                        if index == 3
                        else {}
                    ),
                }
                for index, waveform in enumerate(
                    [
                        {"kind": "constant"},
                        {"kind": "sinusoidal", "frequency_hz": 1.0},
                        {"kind": "pulse", "t_on": 0.0, "t_off": 1.0},
                        {"kind": "piecewise_linear", "points": [[0.0, 0.0], [1.0, 1.0]]},
                        {"kind": "sinc_pulse", "cutoff_hz": 2.0},
                    ]
                )
            ],
            "antenna_spectrum_requests": [
                {
                    "id": "spectrum-stage-output",
                    "solution_ref": {"kind": "stage_output", "stage_id": "solve-1", "output_id": "basis"},
                    "target": {"kind": "global"},
                    "transform": "spatial_fft",
                    "sampling_plane": {
                        "origin_m": [0.0, 0.0, 0.0],
                        "axis_u": [1.0, 0.0, 0.0],
                        "axis_v": [0.0, 1.0, 0.0],
                        "extent_u_m": 1.0,
                        "extent_v_m": 1.0,
                        "sample_count_u": 2,
                        "sample_count_v": 2,
                        "interpolation": "trilinear",
                        "outside_policy": "error",
                    },
                    "window": "rectangular",
                    "normalization": "integral_si",
                    "component": "Hx",
                    "output_id": "spectrum-1",
                    "port_mode_id": None,
                    "nonuniform_k_grid": None,
                    "equilibrium_ref": None,
                },
                {
                    "id": "spectrum-resolved-asset",
                    "solution_ref": {
                        "kind": "resolved_asset",
                        "stage_id": "solve-1",
                        "output_id": "basis",
                        "asset_id": "antenna-spectrum-resolved",
                        "content_digest": "sha256:spectrum-resolved",
                    },
                    "target": {"kind": "object", "object_id": "magnetic-body"},
                    "transform": "nonuniform_spatial_fft",
                    "sampling_plane": {
                        "origin_m": [0.0, 0.0, 0.0],
                        "axis_u": [1.0, 0.0, 0.0],
                        "axis_v": [0.0, 1.0, 0.0],
                        "extent_u_m": 1.0,
                        "extent_v_m": 1.0,
                        "sample_count_u": 2,
                        "sample_count_v": 2,
                        "interpolation": "trilinear",
                        "outside_policy": "zero",
                    },
                    "window": "hann",
                    "normalization": "unitary_discrete",
                    "nonuniform_k_grid": {"k_u_rad_per_m": [0.0, 1.0], "k_v_rad_per_m": [0.0, 1.0]},
                    "component": "Hy",
                    "output_id": "spectrum-2",
                    "port_mode_id": "port-1",
                    "mode_basis_ref": "modes-1",
                },
                {
                    "id": "spectrum-published",
                    "solution_ref": {
                        "stage_id": "solve-1",
                        "output_id": "basis",
                        "asset_id": "antenna-spectrum-published",
                        "content_digest": "sha256:spectrum-published",
                    },
                    "target": {"kind": "region", "object_id": "magnetic-body", "region_id": "film"},
                    "transform": "spatial_fft",
                    "sampling_plane": {
                        "origin_m": [0.0, 0.0, 0.0],
                        "axis_u": [1.0, 0.0, 0.0],
                        "axis_v": [0.0, 1.0, 0.0],
                        "extent_u_m": 1.0,
                        "extent_v_m": 1.0,
                        "sample_count_u": 4,
                        "sample_count_v": 4,
                        "interpolation": "nearest",
                        "outside_policy": "error",
                    },
                    "window": "blackman",
                    "normalization": "integral_si",
                    "component": "Hz",
                    "output_id": "spectrum-3",
                    "equilibrium_ref": "equilibrium-1",
                },
            ],
        }
    )
    return scene


class DevelopmentAntennaSceneAssetsTests(unittest.TestCase):
    def test_accepts_all_current_antenna_ir_shapes_without_inventing_file_assets(self) -> None:
        scene = valid_antenna_scene()
        # asset_id is a typed result reference, not a local source path.
        scene["antenna_target_projections"][2]["solution"]["asset_id"] = "C:/derived/antenna-solution.bin"
        scene["antenna_spectrum_requests"][2]["solution_ref"]["asset_id"] = "C:/derived/spectrum-output.bin"
        original = copy.deepcopy(scene)

        self.assertEqual(collect_scene_assets(scene), [])
        rebased = _rebase_declared_scene_assets(scene, [])

        self.assertEqual(scene, original)
        self.assertEqual(rebased, original)
        self.assertIsNot(rebased, scene)

    def test_accepts_missing_and_empty_serde_default_collections(self) -> None:
        scene = empty_scene()
        scene.update(
            {
                "antenna_port_modes": [],
                "antenna_field_solve_stages": [],
                "antenna_target_projections": [],
                "solved_antenna_drives": [],
                "antenna_spectrum_requests": [],
            }
        )

        self.assertEqual(collect_scene_assets(scene), [])
        self.assertEqual(collect_scene_assets(empty_scene()), [])

    def test_rejects_nested_unknown_path_fields_and_unknown_analysis_owner(self) -> None:
        scene = valid_antenna_scene()
        scene["antenna_port_modes"][0]["branches"][0]["source_path"] = "C:/hidden/source.ovf"
        with self.assertRaisesRegex(SceneAssetError, "source_path"):
            collect_scene_assets(scene)

        scene = empty_scene()
        scene["analysis"] = {"postprocessing_definitions": []}
        with self.assertRaisesRegex(SceneAssetError, "scene fields"):
            collect_scene_assets(scene)

    def test_rejects_malformed_antenna_types_and_unknown_discriminators(self) -> None:
        scene = valid_antenna_scene()
        scene["antenna_port_modes"][0]["normalization_current_a"] = True
        with self.assertRaisesRegex(SceneAssetError, "normalization_current_a must be a number"):
            collect_scene_assets(scene)

        scene = valid_antenna_scene()
        scene["antenna_spectrum_requests"][0]["solution_ref"]["kind"] = "future_solution_kind"
        with self.assertRaisesRegex(SceneAssetError, "solution reference discriminator"):
            collect_scene_assets(scene)

        scene = valid_antenna_scene()
        scene["solved_antenna_drives"][0]["time_origin"] = "future_origin"
        with self.assertRaisesRegex(SceneAssetError, "field time origin"):
            collect_scene_assets(scene)

    def test_enforces_required_fields_but_accepts_option_and_default_omissions(self) -> None:
        scene = valid_antenna_scene()
        # normalization_current_a, waveform defaults, and Option fields are
        # deliberately omitted/null in the valid fixture as permitted by serde.
        self.assertEqual(collect_scene_assets(scene), [])

        scene["solved_antenna_drives"][0].pop("time_origin")
        with self.assertRaisesRegex(SceneAssetError, "missing required fields: time_origin"):
            collect_scene_assets(scene)

        scene = valid_antenna_scene()
        scene["antenna_spectrum_requests"][0]["sampling_plane"].pop("sample_count_u")
        with self.assertRaisesRegex(SceneAssetError, "sample_count_u"):
            collect_scene_assets(scene)


if __name__ == "__main__":
    unittest.main()
