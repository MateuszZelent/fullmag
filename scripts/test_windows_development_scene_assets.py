from __future__ import annotations

import copy
import unittest

from windows.development_scene_assets import (
    SceneAssetError,
    collect_scene_assets,
    _rebase_declared_scene_assets,
)


def empty_scene() -> dict[str, object]:
    return {
        "version": "scene.v2",
        "objects": [],
        "materials": [],
        "magnetization_assets": [],
        "study": {},
        "outputs": {"items": []},
    }


def imported_geometry(source: str) -> dict[str, object]:
    return {
        "geometry_kind": "ImportedGeometry",
        "geometry_params": {"source": source, "units": "nm"},
    }


def verified(assets: list[dict[str, str]]) -> list[dict[str, object]]:
    return [
        {
            "asset_id": asset["asset_id"],
            "sha256": "a" * 64,
            "size_bytes": 10,
            "storage_path": f"C:/storage/capsule/assets/{index}.stl",
        }
        for index, asset in enumerate(assets)
    ]


class DevelopmentSceneAssetsTests(unittest.TestCase):
    def test_unknown_scene_version_or_top_level_owner_cannot_claim_complete_assets(self):
        scene = empty_scene()
        scene["version"] = "scene.v3"
        with self.assertRaisesRegex(SceneAssetError, "scene version"):
            collect_scene_assets(scene)
        scene = empty_scene()
        scene["future_asset_registry"] = {"source_path": "C:/storage/future.dat"}
        with self.assertRaisesRegex(SceneAssetError, "scene fields"):
            collect_scene_assets(scene)

    def test_collects_typed_sources_through_scene_and_ir_csg_shapes(self) -> None:
        scene = empty_scene()
        scene["materials"] = [{"id": "mat", "references": [{"url": "https://example.test/paper"}]}]
        scene["outputs"] = {"items": [{"path": "opaque/output/path"}]}
        scene["magnetization_assets"] = [
            {"id": "mag-1", "kind": "sampled", "source_path": "C:/storage/runs/initial.ovf"}
        ]
        scene["objects"] = [
            {
                "id": "body",
                "name": "Body",
                "magnetization_ref": "mag-1",
                "region_overrides": {"region-1": {"magnetization_ref": "mag-1"}},
                "geometry": {
                    "geometry_kind": "Difference",
                    "geometry_params": {
                        "base": imported_geometry("C:/storage/geometry/base.step"),
                        "tool": {
                            "geometry_kind": "Csg",
                            "geometry_params": {
                                "op": "subtract",
                                "children": [
                                    {"geometry_kind": "Box", "geometry_params": {"size": [1, 1, 1]}},
                                    imported_geometry("C:/storage/geometry/tool.stl"),
                                ],
                            },
                        },
                    },
                },
                "object_mesh": {"mode": "import", "source": "C:/storage/meshes/object.msh"},
                "mesh_override": {"mode": "import", "source": "C:/storage/meshes/override.json"},
                "regions": [
                    {
                        "name": "imported-region",
                        "shape": {
                            "kind": "csg",
                            "expression": {
                                "kind": "union",
                                "a": {
                                    "kind": "imported_geometry",
                                    "name": "region-body",
                                    "source": "C:/storage/geometry/region-body.stl",
                                    "format": "stl",
                                },
                                "b": {"kind": "box", "name": "region-box", "size": [1, 1, 1]},
                            },
                        },
                    }
                ],
                "material_parameter_fields": [],
            }
        ]
        scene["study"] = {
            "initial_state": {
                "source_path": "C:/storage/runs/study-initial.ovf",
                "format": "ovf",
            },
            "mesh_interfaces": [
                {"interface_id": "interface-1", "config": {"mode": "import", "source": "C:/storage/meshes/interface.mesh"}}
            ],
            # These current typed global mesh settings have no declared source field.
            "universe_mesh": {"mode": "bounds", "size": [1, 1, 1]},
            "shared_domain_mesh": {"operations": [{"kind": "opaque", "params": {"path": "future/opaque"}}]},
        }

        assets = collect_scene_assets(scene)

        self.assertEqual(
            assets,
            [
                {"asset_id": "/magnetization_assets/0/source_path", "source_path": "C:/storage/runs/initial.ovf"},
                {"asset_id": "/objects/0/geometry/geometry_params/base/geometry_params/source", "source_path": "C:/storage/geometry/base.step"},
                {"asset_id": "/objects/0/geometry/geometry_params/tool/geometry_params/children/1/geometry_params/source", "source_path": "C:/storage/geometry/tool.stl"},
                {"asset_id": "/objects/0/object_mesh/source", "source_path": "C:/storage/meshes/object.msh"},
                {"asset_id": "/objects/0/mesh_override/source", "source_path": "C:/storage/meshes/override.json"},
                {"asset_id": "/objects/0/regions/0/shape/expression/a/source", "source_path": "C:/storage/geometry/region-body.stl"},
                {"asset_id": "/study/initial_state/source_path", "source_path": "C:/storage/runs/study-initial.ovf"},
                {"asset_id": "/study/mesh_interfaces/0/config/source", "source_path": "C:/storage/meshes/interface.mesh"},
            ],
        )

    def test_rebase_is_exact_and_does_not_mutate_the_authored_scene(self) -> None:
        scene = empty_scene()
        scene["magnetization_assets"] = [
            {"id": "mag-1", "kind": "sampled", "source_path": "C:/storage/runs/initial.ovf"}
        ]
        scene["objects"] = [
            {
                "id": "body",
                "magnetization_ref": "mag-1",
                "geometry": imported_geometry("C:/storage/geometry/body.stl"),
                "material_ref": "mat-1",
                "material_parameter_fields": [],
            }
        ]
        scene["study"] = {
            "requested_device": "gpu",
            "initial_state": {"source_path": "C:/storage/runs/start.ovf", "format": "ovf"},
        }
        original = copy.deepcopy(scene)
        assets = collect_scene_assets(scene)
        restored = _rebase_declared_scene_assets(scene, verified(assets))

        self.assertEqual(scene, original)
        self.assertEqual(restored["magnetization_assets"][0]["source_path"], "C:/storage/capsule/assets/0.stl")
        self.assertEqual(restored["objects"][0]["geometry"]["geometry_params"]["source"], "C:/storage/capsule/assets/1.stl")
        self.assertEqual(restored["study"]["initial_state"]["source_path"], "C:/storage/capsule/assets/2.stl")
        self.assertEqual(restored["objects"][0]["magnetization_ref"], "mag-1")
        self.assertEqual(restored["study"]["requested_device"], scene["study"].get("requested_device"))

    def test_verified_manifest_must_match_references_exactly(self) -> None:
        scene = empty_scene()
        scene["objects"] = [
            {
                "id": "body",
                "geometry": imported_geometry("C:/storage/body.stl"),
                "material_parameter_fields": [],
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "missing verified assets"):
            _rebase_declared_scene_assets(scene, [])

        with self.assertRaisesRegex(SceneAssetError, "unreferenced verified assets"):
            _rebase_declared_scene_assets(
                empty_scene(),
                [{"asset_id": "/orphan", "sha256": "a" * 64, "size_bytes": 10, "storage_path": "C:/capsule/orphan.stl"}],
            )

    def test_rejects_empty_imported_sources_unknown_geometries_and_presets(self) -> None:
        scene = empty_scene()
        scene["objects"] = [{"id": "body", "geometry": imported_geometry(" "), "material_parameter_fields": []}]
        with self.assertRaisesRegex(SceneAssetError, "non-empty string"):
            collect_scene_assets(scene)

        scene["objects"][0]["geometry"] = {"geometry_kind": "FutureMesh", "geometry_params": {"path": "opaque"}}
        with self.assertRaisesRegex(SceneAssetError, "Unsupported geometry kind"):
            collect_scene_assets(scene)

        scene = empty_scene()
        scene["magnetization_assets"] = [
            {"id": "mag-1", "kind": "preset_texture", "preset_kind": "unknown_future_texture"}
        ]
        with self.assertRaisesRegex(SceneAssetError, "asset semantics are unknown"):
            collect_scene_assets(scene)

    def test_rejects_dangling_magnetization_refs_and_unregistered_sampled_asset_ids(self) -> None:
        scene = empty_scene()
        scene["objects"] = [
            {"id": "body", "magnetization_ref": "missing", "geometry": {"geometry_kind": "Box"}, "material_parameter_fields": []}
        ]
        with self.assertRaisesRegex(SceneAssetError, "does not resolve"):
            collect_scene_assets(scene)

        scene["objects"][0]["magnetization_ref"] = None
        scene["objects"][0]["material_parameter_fields"] = [
            {"parameter": "Ms", "value": {"kind": "sampled", "asset_id": "field-1", "component_count": 1, "location": "cell", "unit": "A/m"}}
        ]
        with self.assertRaisesRegex(SceneAssetError, "no file-backed registry"):
            collect_scene_assets(scene)

        scene["objects"][0]["material_parameter_fields"] = []
        scene["objects"][0]["regions"] = [
            {
                "name": "region-1",
                "shape": {"kind": "box", "size": [1, 1, 1], "center": [0, 0, 0]},
                "texture_override": {
                    "initial_magnetization": {"kind": "preset_texture", "preset_kind": "future_file_backed_preset"}
                },
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "asset semantics are unknown"):
            collect_scene_assets(scene)

    def test_rejects_unresolved_imported_solid_and_explicit_frozen_field_assets(self) -> None:
        scene = empty_scene()
        scene["selections"] = [
            {
                "id": "selection-1",
                "expression": {
                    "kind": "inside_geometry",
                    "geometry": {"kind": "imported_solid", "asset_id": "solid-1"},
                },
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "ImportedSolid asset.*no file-backed registry"):
            collect_scene_assets(scene)

        scene["selections"] = []
        scene["magnetization_constraints"] = [
            {
                "kind": "frozen_spins",
                "selector": {"kind": "all_magnetic"},
                "reference": {"kind": "explicit_field_asset", "asset_id": "field-1"},
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "Explicit frozen-field asset.*no file-backed registry"):
            collect_scene_assets(scene)

    def test_bounds_recursive_scene_walk(self) -> None:
        geometry: dict[str, object] = {"geometry_kind": "Box", "geometry_params": {}}
        for _ in range(140):
            geometry = {
                "geometry_kind": "Difference",
                "geometry_params": {"base": geometry, "tool": {"geometry_kind": "Box", "geometry_params": {}}},
            }
        scene = empty_scene()
        scene["objects"] = [{"id": "body", "geometry": geometry, "material_parameter_fields": []}]
        with self.assertRaisesRegex(SceneAssetError, "depth limit"):
            collect_scene_assets(scene)

    def test_bounds_declared_asset_count(self) -> None:
        scene = empty_scene()
        scene["magnetization_assets"] = [
            {"id": f"mag-{index}", "kind": "sampled", "source_path": f"C:/storage/{index}.ovf"}
            for index in range(513)
        ]
        with self.assertRaisesRegex(SceneAssetError, "more than 512 declared file references"):
            collect_scene_assets(scene)

    def test_collects_disabled_nested_pipeline_study_file_dependencies(self) -> None:
        scene = empty_scene()
        scene["study"] = {
            "study_pipeline": {
                "version": "study_pipeline.v1",
                "nodes": [
                    {
                        "node_kind": "group",
                        "id": "outer",
                        "enabled": False,
                        "children": [
                            {
                                "node_kind": "primitive",
                                "stage_kind": "frequency_response",
                                "enabled": False,
                                "payload": {
                                    "equilibrium_source": "artifact",
                                    "frequency_equilibrium_source": "artifact",
                                    "equilibrium_artifact": "C:/study/equilibrium.ovf",
                                    "frequency_equilibrium_artifact": "C:/study/equilibrium.ovf",
                                },
                            },
                            {
                                "node_kind": "macro",
                                "macro_kind": "relax_eigenmodes",
                                "config": {
                                    "eigen_count": 6,
                                    "eigen_equilibrium_source": "artifact",
                                    "eigen_equilibrium_artifact": "C:/study/macro-equilibrium.ovf",
                                },
                            },
                            {
                                "node_kind": "group",
                                "id": "nested",
                                "children": [
                                    {
                                        "node_kind": "primitive",
                                        "stage_kind": "load_state",
                                        "enabled": False,
                                        "payload": {
                                            "artifact_name": None,
                                            "state_path": "C:/study/seed.ovf",
                                        },
                                    }
                                ],
                            },
                        ],
                    }
                ],
            }
        }

        self.assertEqual(
            collect_scene_assets(scene),
            [
                {
                    "asset_id": "/study/study_pipeline/nodes/0/children/0/payload/equilibrium_artifact",
                    "source_path": "C:/study/equilibrium.ovf",
                },
                {
                    "asset_id": "/study/study_pipeline/nodes/0/children/0/payload/frequency_equilibrium_artifact",
                    "source_path": "C:/study/equilibrium.ovf",
                },
                {
                    "asset_id": "/study/study_pipeline/nodes/0/children/1/config/eigen_equilibrium_artifact",
                    "source_path": "C:/study/macro-equilibrium.ovf",
                },
                {
                    "asset_id": "/study/study_pipeline/nodes/0/children/2/children/0/payload/state_path",
                    "source_path": "C:/study/seed.ovf",
                },
            ],
        )

    def test_legacy_stages_accept_exporter_action_kinds_and_rebase_typed_inputs(self) -> None:
        scene = empty_scene()
        scene["study"] = {
            "stages": [
                {"kind": "set_transport_current", "payload": {"module_id": "transport-1"}},
                {"kind": "set_spin_torque_enabled", "payload": {"module_id": "torque-1", "enabled": True}},
                {
                    "kind": "eigenmodes",
                    "payload": {
                        "eigen_equilibrium_source": "artifact",
                        "eigen_equilibrium_artifact": "C:/study/eigen.ovf",
                    },
                },
                {
                    "kind": "load_state",
                    "payload": {"artifact_name": None, "state_path": "C:/study/load.ovf"},
                },
                {
                    "kind": "load_state",
                    "payload": {"artifact_name": "relaxed-stage", "state_path": None},
                },
            ]
        }
        assets = collect_scene_assets(scene)
        restored = _rebase_declared_scene_assets(scene, verified(assets))

        self.assertEqual([asset["source_path"] for asset in assets], ["C:/study/eigen.ovf", "C:/study/load.ovf"])
        self.assertEqual(
            restored["study"]["stages"][2]["payload"]["eigen_equilibrium_artifact"],
            "C:/storage/capsule/assets/0.stl",
        )
        self.assertEqual(
            restored["study"]["stages"][3]["payload"]["state_path"],
            "C:/storage/capsule/assets/1.stl",
        )
        self.assertEqual(restored["study"]["stages"][4]["payload"]["artifact_name"], "relaxed-stage")

    def test_rejects_unknown_stage_macro_and_opaque_macro_fields(self) -> None:
        scene = empty_scene()
        scene["study"] = {
            "study_pipeline": {
                "version": "study_pipeline.v1",
                "nodes": [{"node_kind": "primitive", "stage_kind": "future_stage", "payload": {}}],
            }
        }
        with self.assertRaisesRegex(SceneAssetError, "Unsupported study pipeline stage_kind"):
            collect_scene_assets(scene)

        scene["study"]["study_pipeline"]["nodes"] = [
            {"node_kind": "macro", "macro_kind": "future_macro", "config": {}}
        ]
        with self.assertRaisesRegex(SceneAssetError, "Unsupported study pipeline macro_kind"):
            collect_scene_assets(scene)

        scene["study"]["study_pipeline"]["nodes"] = [
            {
                "node_kind": "macro",
                "macro_kind": "relax_run",
                "config": {"future_source_path": "C:/study/hidden.ovf"},
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "Unsupported relax_run macro config fields"):
            collect_scene_assets(scene)

        scene["study"]["study_pipeline"]["nodes"] = [
            {
                "node_kind": "macro",
                "macro_kind": "relax_eigenmodes",
                "config": {"eigen_equilibrium_source": "artifact"},
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "missing eigen_equilibrium_artifact"):
            collect_scene_assets(scene)

        scene["study"]["study_pipeline"]["nodes"] = [
            {
                "node_kind": "primitive",
                "stage_kind": "eigenmodes",
                "payload": {"future_source_path": "C:/study/hidden.ovf"},
            }
        ]
        with self.assertRaisesRegex(SceneAssetError, "Unsupported eigenmodes payload fields"):
            collect_scene_assets(scene)

    def test_rejects_missing_or_conflicting_equilibrium_artifacts_and_bad_alias_types(self) -> None:
        scene = empty_scene()
        scene["study"] = {
            "stages": [
                {"kind": "eigenmodes", "payload": {"eigen_equilibrium_source": "artifact"}}
            ]
        }
        with self.assertRaisesRegex(SceneAssetError, "missing equilibrium_artifact"):
            collect_scene_assets(scene)

        scene["study"]["stages"][0]["payload"]["eigen_equilibrium_artifact"] = "C:/study/a.ovf"
        scene["study"]["stages"][0]["payload"]["equilibrium_artifact"] = "C:/study/b.ovf"
        with self.assertRaisesRegex(SceneAssetError, "Conflicting eigenmodes equilibrium artifact aliases"):
            collect_scene_assets(scene)

        scene["study"]["stages"][0]["payload"]["equilibrium_artifact"] = "C:/study/a.ovf"
        scene["study"]["stages"][0]["payload"]["equilibrium_source"] = "relax"
        scene["study"]["stages"][0]["payload"]["eigen_equilibrium_source"] = "artifact"
        with self.assertRaisesRegex(SceneAssetError, "Conflicting eigenmodes equilibrium source fields"):
            collect_scene_assets(scene)

        scene["study"]["stages"][0]["payload"] = {"eigen_equilibrium_source": []}
        with self.assertRaisesRegex(SceneAssetError, "equilibrium source must be a non-empty string"):
            collect_scene_assets(scene)

        scene["study"]["stages"][0]["payload"] = {
            "equilibrium": {"kind": "artifact"},
        }
        with self.assertRaisesRegex(SceneAssetError, "Artifact equilibrium is missing path"):
            collect_scene_assets(scene)

    def test_load_state_requires_one_dependency_and_rejects_missing_file_path(self) -> None:
        scene = empty_scene()
        scene["study"] = {
            "study_pipeline": {
                "version": "study_pipeline.v1",
                "nodes": [
                    {"node_kind": "primitive", "stage_kind": "load_state", "payload": {}}
                ],
            }
        }
        with self.assertRaisesRegex(SceneAssetError, "requires exactly one of artifact_name or state_path"):
            collect_scene_assets(scene)

        scene["study"]["study_pipeline"]["nodes"][0]["payload"] = {
            "artifact_name": None,
            "state_path": "",
        }
        with self.assertRaisesRegex(SceneAssetError, "state_path must be a non-empty string"):
            collect_scene_assets(scene)


if __name__ == "__main__":
    unittest.main()
