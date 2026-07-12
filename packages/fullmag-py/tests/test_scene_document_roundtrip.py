from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
)


def test_scene_document_round_trips_eigenmode_periodic_airbox_k0() -> None:
    builder = {
        "stages": [
            {
                "kind": "eigenmodes",
                "eigen_magnetostatic_bc": "periodic_airbox_k0",
            }
        ]
    }

    scene = build_scene_document_from_builder(builder)
    rebuilt = build_builder_from_scene_document(scene)

    assert rebuilt["stages"][0]["eigen_magnetostatic_bc"] == "periodic_airbox_k0"
