"""Project-owned STL identity must survive canonical authoring adapters."""
import pytest

from fullmag.runtime.scene_document import (
    build_builder_from_scene_document,
    build_scene_document_from_builder,
    builder_overrides_from_scene_document,
)


def _builder(reference):
    return {"geometries": [{
        "name": "body", "geometry_kind": "ImportedGeometry",
        "geometry_params": {"source": "body.stl", "scale": 1e-6},
        "source_asset": reference,
        "material": {"Ms": 400000.0, "Aex": 8e-12, "alpha": 0.5},
        "magnetization": {"kind": "uniform", "value": [1.0, 0.0, 0.0]},
    }]}


def _reference():
    return {"asset_id": "asset-source", "content_sha256": "a" * 64,
            "archive_path": "project/assets/geometry/source.stl"}


def test_imported_source_asset_survives_both_adapters_and_overrides():
    reference = _reference()
    scene = build_scene_document_from_builder(_builder(reference))
    assert scene["objects"][0]["geometry"]["source_asset"] == reference
    rebuilt = build_builder_from_scene_document(scene)
    assert rebuilt["geometries"][0]["source_asset"] == reference
    overrides = builder_overrides_from_scene_document(scene)
    assert overrides["geometries"][0]["source_asset"] == reference
    # Returned metadata must not alias the mutable incoming request.
    reference["asset_id"] = "changed-after-import"
    assert scene["objects"][0]["geometry"]["source_asset"]["asset_id"] == "asset-source"


@pytest.mark.parametrize("field,value", [
    ("asset_id", ""), ("asset_id", "a/b"), ("asset_id", "a\\b"),
    ("asset_id", "a\x00b"), ("asset_id", "x" * 257),
    ("content_sha256", "A" * 64), ("content_sha256", "x" * 64),
    ("content_sha256", "a" * 63),
    ("archive_path", "/project/assets/source.stl"),
    ("archive_path", "project/assets/../source.stl"),
    ("archive_path", "project/assets//source.stl"),
    ("archive_path", "project/assets/./source.stl"),
    ("archive_path", "project/assets/source.stl/"),
    ("archive_path", "project/assets/C:source.stl"),
    ("archive_path", "project/assets/source\x00.stl"),
    ("archive_path", "other/assets/source.stl"),
])
def test_invalid_source_reference_is_rejected_on_both_boundaries(field, value):
    reference = _reference()
    reference[field] = value
    with pytest.raises(ValueError, match="source_asset"):
        build_scene_document_from_builder(_builder(reference))
    scene = build_scene_document_from_builder(_builder(_reference()))
    scene["objects"][0]["geometry"]["source_asset"] = reference
    with pytest.raises(ValueError, match="source_asset"):
        build_builder_from_scene_document(scene)


def test_legacy_import_omits_unbound_identity():
    scene = build_scene_document_from_builder(_builder(None))
    assert "source_asset" not in scene["objects"][0]["geometry"]
    assert "source_asset" not in build_builder_from_scene_document(scene)["geometries"][0]


def test_bound_source_cannot_be_reinterpreted_as_an_analytic_primitive():
    builder = _builder(_reference())
    builder["geometries"][0]["geometry_kind"] = "Box"
    builder["geometries"][0]["geometry_params"] = {"size": [1.0, 1.0, 1.0]}
    with pytest.raises(ValueError, match="source_asset"):
        build_scene_document_from_builder(builder)


@pytest.mark.parametrize("scale,units,expected", [
    (0.5, "mm", 5e-4),
    ([1.0, 2.0, 3.0], "nm", (1e-9, 2e-9, 3e-9)),
])
def test_imported_units_survive_both_canonical_script_render_paths(scale, units, expected):
    import fullmag as fm
    from pathlib import Path
    from fullmag.runtime.script_builder import (
        _render_shape_expression, _render_geometry_expr_from_override,
    )
    params = {"source": "not-read.stl", "scale": scale, "units": units}
    expressions = [
        _render_shape_expression({"geometry_kind": "ImportedGeometry", "geometry_params": params}),
        _render_geometry_expr_from_override("ImportedGeometry", params, name="body", source_root=Path.cwd()),
    ]
    for expression in expressions:
        geometry = eval(expression, {"fm": fm})
        assert geometry.scale == pytest.approx(expected)
