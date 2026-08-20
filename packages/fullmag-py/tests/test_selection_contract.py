from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import textwrap

import pytest

import fullmag as fm
from fullmag import select as sel
from fullmag.model.selection import SelectionGeometry as SelectionPredicateGeometry
from fullmag.runtime.script_builder import (
    export_builder_draft,
    rewrite_loaded_problem_script,
)


@dataclass(frozen=True)
class _Object:
    object_id: str


@dataclass(frozen=True)
class _Region:
    owner_object: str
    region_id: str


@dataclass(frozen=True)
class _NamedOnlyObject:
    name: str


@dataclass
class _ForeignGeometry:
    def to_ir(self) -> dict[str, object]:
        return {"kind": "sphere", "radius_m": 1.0, "center_m": [0.0, 0.0, 0.0]}


def test_selection_dsl_builds_typed_boolean_expression() -> None:
    magnet = _Object("free_layer")
    pinning = _Region("free_layer", "pinning")

    selector = (
        sel.in_region(magnet, pinning)
        & (sel.m.z > 0.5)
        & sel.between(sel.m.x, -0.4, 0.4)
    )

    assert selector.to_ir() == {
        "kind": "and",
        "expressions": [
            {
                "kind": "in_region",
                "object_id": "free_layer",
                "region_id": "pinning",
            },
            {
                "kind": "compare",
                "lhs": {"kind": "magnetization_component", "component": "z"},
                "op": "gt",
                "rhs": {"kind": "constant", "value": 0.5},
            },
            {
                "kind": "between",
                "value": {"kind": "magnetization_component", "component": "x"},
                "lower": -0.4,
                "upper": 0.4,
                "closed": "both",
            },
        ],
    }


def test_selection_uses_real_fullmag_object_and_region_handles_with_explicit_ids() -> (
    None
):
    fm.reset()
    try:
        study = fm.study("selection handles")
        magnet = study.geometry(
            fm.Box(size=(100e-9, 50e-9, 3e-9)),
            name="User-facing free layer",
            object_id="free_layer",
        )
        region = magnet.add_region(
            "User-facing pinning region",
            fm.Sphere(10e-9),
            region_id="pinning",
        )

        assert magnet.object_id == "free_layer"
        assert region.owner_object == "free_layer"
        assert sel.in_object(magnet).to_ir() == {
            "kind": "in_object",
            "object_id": "free_layer",
        }
        assert sel.in_region(magnet, region).to_ir() == {
            "kind": "in_region",
            "object_id": "free_layer",
            "region_id": "pinning",
        }
    finally:
        fm.reset()


def test_selection_never_infers_object_identity_from_user_facing_name() -> None:
    with pytest.raises(TypeError, match="object_id"):
        sel.in_object(_NamedOnlyObject("free_layer"))


def test_explicit_object_id_survives_canonical_script_round_trip() -> None:
    source = """
        import fullmag as fm

        study = fm.study("selection identity round-trip")
        magnet = study.geometry(
            fm.Box(size=(100e-9, 50e-9, 3e-9)),
            name="User-facing free layer",
            object_id="free_layer",
        )
        magnet.Ms = 800e3
        magnet.Aex = 13e-12
        study.stages.add_relax(
            stage_id="relax",
            algorithm="projected_gradient_bb",
            max_steps=1,
        )
    """

    with TemporaryDirectory() as temporary_directory:
        root = Path(temporary_directory)
        original_path = root / "original.py"
        original_path.write_text(textwrap.dedent(source), encoding="utf-8")
        loaded = fm.load_problem_from_script(original_path, lightweight_assets=True)

        rendered = rewrite_loaded_problem_script(
            loaded,
            overrides=export_builder_draft(loaded),
        )["rendered_source"]
        assert 'object_id="free_layer"' in rendered

        rewritten_path = root / "rewritten.py"
        rewritten_path.write_text(str(rendered), encoding="utf-8")
        rewritten = fm.load_problem_from_script(rewritten_path, lightweight_assets=True)

    magnet_ir = rewritten.stages[-1].problem.magnets[0].to_ir()
    assert magnet_ir["object_id"] == "free_layer"


def test_selection_rejects_callable_string_and_raw_mapping_expressions() -> None:
    for value in [lambda point: True, "m.z > 0.5", {"kind": "all_magnetic"}]:
        with pytest.raises(TypeError, match="typed selection expression"):
            fm.Selection(value)

    with pytest.raises(TypeError, match="typed Fullmag geometry"):
        sel.inside(_ForeignGeometry())


def test_inside_accepts_complete_typed_geometry_predicate_v1() -> None:
    geometry = SelectionPredicateGeometry.from_ir(
        {
            "kind": "xor",
            "a": {
                "kind": "ellipsoid",
                "center_m": [0.0, 0.0, 0.0],
                "radii_m": [1.0, 2.0, 3.0],
            },
            "b": {
                "kind": "complement",
                "geometry": {
                    "kind": "sphere",
                    "center_m": [0.0, 0.0, 0.0],
                    "radius_m": 0.5,
                },
                "domain": {
                    "kind": "box",
                    "center_m": [0.0, 0.0, 0.0],
                    "size_m": [4.0, 4.0, 4.0],
                },
            },
        }
    )

    selector = sel.inside(geometry)

    assert selector.to_ir()["geometry"] == geometry.to_ir()


def test_inside_knows_imported_solid_but_hash_validation_fails_closed() -> None:
    geometry = SelectionPredicateGeometry.from_ir(
        {"kind": "imported_solid", "asset_id": "mesh:free-layer"}
    )
    selector = sel.inside(geometry)

    with pytest.raises(ValueError, match="selection_imported_solid_unqualified"):
        sel.canonical_selection_sha256(selector.definition(selection_id="imported"))


def test_selection_serialization_is_copy_safe() -> None:
    selector = sel.inside(fm.shapes.disk(radius=25e-9, thickness=3e-9))
    payload = selector.to_ir()
    payload["geometry"]["radius_m"] = 999.0

    assert selector.to_ir()["geometry"]["radius_m"] == 25e-9


def test_named_selection_ids_and_refs_are_deterministic() -> None:
    selector = sel.in_object("free_layer") & (sel.m.z > 0.5)

    first = selector.definition(name="Pinned positive spins")
    second = selector.definition(name="Pinned positive spins")

    assert first == second
    assert first["id"].startswith("selection_")
    assert selector.ref().to_ir() == {
        "kind": "ref",
        "selection_id": first["id"],
    }
    assert selector.sha256() == selector.sha256()
    assert len(selector.sha256()) == 64


def test_canonical_selection_hash_includes_dependencies_and_matches_rust() -> None:
    leaf = sel.all_magnetic().definition(selection_id="leaf")
    root = sel.all_magnetic().ref("leaf").definition(selection_id="root")

    digest = sel.canonical_selection_sha256(root, dependencies=[leaf])

    assert digest == "37ccb1ac788b858b5513c7a2da296793cdbb8ad2e7f29efbdd21a6b6db7cf1ab"
    changed_leaf = sel.in_object("free_layer").definition(selection_id="leaf")
    assert sel.canonical_selection_sha256(root, dependencies=[changed_leaf]) != digest

    unicode_definition = sel.in_object("próbka_ą").definition(selection_id="warstwa_ż")
    assert sel.canonical_selection_sha256(unicode_definition) == (
        "98fb0dbc117d3ca0f1aa2018544be79e45200858c54139fb1f4b836f3974bde1"
    )


def test_canonical_selection_hash_typed_parses_and_normalizes_before_hashing() -> None:
    unnormalized = {
        "schema_version": "selection_expr.v1",
        "id": "axis",
        "expression": {
            "kind": "inside_geometry",
            "geometry": {
                "kind": "cylinder",
                "center_m": [0.0, 0.0, 0.0],
                "axis": [0.0, 0.0, 4.0],
                "radius_m": 2.5e-8,
                "height_m": 3e-9,
            },
            "frame": {"kind": "world"},
            "sampling": {"kind": "dof_point"},
            "boundary": {
                "kind": "inclusive",
                "absolute_tolerance_m": 0.0,
                "relative_tolerance": 1e-12,
            },
        },
    }
    normalized = json.loads(json.dumps(unnormalized))
    normalized["expression"]["geometry"]["axis"] = [0.0, 0.0, 1.0]

    assert sel.canonical_selection_sha256(
        unnormalized
    ) == sel.canonical_selection_sha256(normalized)


@pytest.mark.parametrize(
    "definition",
    [
        {
            "schema_version": "selection_expr.v1",
            "id": "unknown-field",
            "expression": {"kind": "all_magnetic", "extra": True},
        },
        {
            "schema_version": "selection_expr.v1",
            "id": "string-program",
            "expression": "m.z > 0.5",
        },
        {
            "schema_version": "selection_expr.v1",
            "id": "invalid-geometry",
            "expression": {
                "kind": "inside_geometry",
                "geometry": {
                    "kind": "ellipsoid",
                    "center_m": [0.0, 0.0, 0.0],
                    "radii_m": [1.0, 0.0, 1.0],
                },
                "frame": {"kind": "world"},
                "sampling": {"kind": "dof_point"},
                "boundary": {
                    "kind": "inclusive",
                    "absolute_tolerance_m": 0.0,
                    "relative_tolerance": 1e-12,
                },
            },
        },
        {
            "schema_version": "selection_expr.v1",
            "id": "empty-and",
            "expression": {"kind": "and", "expressions": []},
        },
    ],
)
def test_canonical_selection_hash_rejects_invalid_untyped_payloads(
    definition: dict[str, object],
) -> None:
    with pytest.raises((TypeError, ValueError)):
        sel.canonical_selection_sha256(definition)


def test_canonical_selection_hash_rejects_unqualified_imported_solid() -> None:
    definition = {
        "schema_version": "selection_expr.v1",
        "id": "imported",
        "expression": {
            "kind": "inside_geometry",
            "geometry": {"kind": "imported_solid", "asset_id": "asset_mesh_001"},
            "frame": {"kind": "world"},
            "sampling": {"kind": "dof_point"},
            "boundary": {
                "kind": "inclusive",
                "absolute_tolerance_m": 0.0,
                "relative_tolerance": 1e-12,
            },
        },
    }

    with pytest.raises(ValueError, match="selection_imported_solid_unqualified"):
        sel.canonical_selection_sha256(definition)


def test_python_selection_json_matches_canonical_rust_fixture() -> None:
    selector = (
        sel.in_object("free_layer")
        & sel.inside(
            fm.shapes.disk(radius=25e-9, thickness=3e-9),
            frame="free_layer",
        )
        & (sel.m.z > 0.5)
    )

    actual = selector.definition(
        selection_id="pinned_positive_core",
        name="Pinned positive core",
    )
    fixture_path = (
        Path(__file__).parents[3]
        / "crates/fullmag-ir/tests/fixtures/selection_expr_v1_python_golden.json"
    )

    assert actual == json.loads(fixture_path.read_text(encoding="utf-8"))
    assert sel.canonical_selection_sha256(actual) == (
        "036780fa25429c74f9b5298b928e9712895c448c599cafbba5e5a192da320582"
    )


def test_selection_scalar_typed_parse_normalizes_and_round_trips_every_variant() -> (
    None
):
    fixtures = [
        {"kind": "constant", "value": 0.5},
        {"kind": "coordinate", "component": "x", "frame": {"kind": "world"}},
        {"kind": "magnetization_component", "component": "z"},
        {"kind": "magnetization_norm"},
        {"kind": "magnetization_dot", "axis": [0.0, 0.0, 4.0]},
        {"kind": "abs", "value": {"kind": "constant", "value": -0.5}},
    ]

    for fixture in fixtures:
        restored = fm.SelectionScalar.from_ir(fixture)
        expected = json.loads(json.dumps(fixture))
        if expected["kind"] == "magnetization_dot":
            expected["axis"] = [0.0, 0.0, 1.0]
        assert restored.to_ir() == expected


def test_selection_geometry_typed_parse_round_trips_every_v1_variant() -> None:
    sphere = {"kind": "sphere", "center_m": [0.0, 0.0, 0.0], "radius_m": 1.0}
    box = {"kind": "box", "center_m": [0.0, 0.0, 0.0], "size_m": [4.0, 4.0, 4.0]}
    fixtures = [
        box,
        {
            "kind": "cylinder",
            "center_m": [0.0, 0.0, 0.0],
            "axis": [0.0, 0.0, 2.0],
            "radius_m": 1.0,
            "height_m": 2.0,
        },
        sphere,
        {"kind": "ellipsoid", "center_m": [0.0, 0.0, 0.0], "radii_m": [1.0, 2.0, 3.0]},
        {"kind": "union", "a": sphere, "b": box},
        {"kind": "intersection", "a": sphere, "b": box},
        {"kind": "difference", "base": box, "tool": sphere},
        {"kind": "xor", "a": sphere, "b": box},
        {"kind": "complement", "geometry": sphere, "domain": box},
        {
            "kind": "affine",
            "geometry": sphere,
            "translation_m": [1.0, 2.0, 3.0],
            "rotation_xyzw": [0.0, 0.0, 0.0, 2.0],
            "scale": [1.0, 2.0, 3.0],
            "pivot_m": [0.0, 0.0, 0.0],
        },
        {"kind": "imported_solid", "asset_id": "asset_mesh_001"},
    ]

    for fixture in fixtures:
        restored = SelectionPredicateGeometry.from_ir(fixture)
        expected = json.loads(json.dumps(fixture))
        if expected["kind"] == "cylinder":
            expected["axis"] = [0.0, 0.0, 1.0]
        if expected["kind"] == "affine":
            expected["rotation_xyzw"] = [0.0, 0.0, 0.0, 1.0]
        assert restored.to_ir() == expected


def test_selection_and_definition_typed_parse_canonicalize_nested_booleans() -> None:
    payload = {
        "schema_version": "selection_expr.v1",
        "id": "nested",
        "name": "Nested selection",
        "expression": {
            "kind": "and",
            "expressions": [
                {"kind": "all_magnetic"},
                {
                    "kind": "and",
                    "expressions": [
                        {"kind": "in_object", "object_id": "free_layer"},
                        {
                            "kind": "not",
                            "expression": {
                                "kind": "in_object",
                                "object_id": "fixed_layer",
                            },
                        },
                    ],
                },
            ],
        },
    }

    definition = fm.SelectionDefinition.from_ir(payload)
    expression = fm.Selection.from_ir(payload["expression"])

    assert definition.to_ir() == {
        "schema_version": "selection_expr.v1",
        "id": "nested",
        "name": "Nested selection",
        "expression": expression.to_ir(),
    }
    assert expression.to_ir()["kind"] == "and"
    assert len(expression.to_ir()["expressions"]) == 3


def test_typed_selection_deserialization_is_copy_safe_and_strict() -> None:
    payload = {"kind": "in_object", "object_id": "free_layer"}
    restored = fm.Selection.from_ir(payload)
    payload["object_id"] = "mutated"
    serialized = restored.to_ir()
    serialized["object_id"] = "mutated-again"

    assert restored.to_ir() == {"kind": "in_object", "object_id": "free_layer"}
    with pytest.raises(ValueError, match="unknown fields"):
        fm.Selection.from_ir({"kind": "all_magnetic", "extra": True})


def test_through_object_lowers_to_finite_cylinder_intersected_with_object() -> None:
    authored = fm.shapes.disk(
        radius=25e-9,
        center=(0.0, 0.0, 1e-9),
        extrusion="through_object",
        object_id="free_layer",
    )

    selector = sel.inside(
        authored,
        object_bounds_m={"free_layer": ((-50e-9, -25e-9, -2e-9), (50e-9, 25e-9, 4e-9))},
    )
    payload = selector.to_ir()

    assert payload["kind"] == "and"
    assert payload["expressions"][0] == {
        "kind": "in_object",
        "object_id": "free_layer",
    }
    inside = payload["expressions"][1]
    assert inside["kind"] == "inside_geometry"
    assert inside["frame"] == {"kind": "object", "object_id": "free_layer"}
    assert inside["geometry"] == {
        "kind": "cylinder",
        "center_m": [0.0, 0.0, 1e-9],
        "axis": [0.0, 0.0, 1.0],
        "radius_m": 25e-9,
        "height_m": pytest.approx(6e-9),
    }
    assert "through_object" not in repr(payload)


def test_through_object_requires_bounds_at_selection_lowering() -> None:
    authored = fm.shapes.disk(
        radius=25e-9,
        extrusion="through_object",
        object_id="free_layer",
    )

    with pytest.raises(ValueError, match="object_bounds_m"):
        sel.inside(authored)


def test_through_object_accepts_matching_object_frame_and_rejects_mismatch() -> None:
    authored = fm.shapes.disk(
        radius=25e-9,
        extrusion="through_object",
        object_id="free_layer",
    )
    bounds = {"free_layer": ((-1.0, -1.0, -1.0), (1.0, 1.0, 1.0))}

    payload = sel.inside(
        authored,
        frame=_Object("free_layer"),
        object_bounds_m=bounds,
    ).to_ir()
    assert payload["expressions"][1]["frame"] == {
        "kind": "object",
        "object_id": "free_layer",
    }

    with pytest.raises(ValueError, match="frame must match"):
        sel.inside(
            authored,
            frame=_Object("other"),
            object_bounds_m=bounds,
        )


@pytest.mark.parametrize(
    "geometry",
    [
        fm.Box(size=(2.0, 4.0, 6.0)),
        fm.Cylinder(radius=2.0, height=4.0),
        fm.Sphere(3.0),
        fm.Sphere(2.0) + fm.Box(size=(1.0, 1.0, 1.0)),
        fm.Sphere(2.0) & fm.Box(size=(1.0, 1.0, 1.0)),
        fm.Box(size=(4.0, 4.0, 4.0)) - fm.Sphere(1.0),
        fm.Box(size=(2.0, 2.0, 2.0)).translate((1.0, 2.0, 3.0)),
    ],
)
def test_selection_inside_lowers_required_legacy_geometry_variants(
    geometry: object,
) -> None:
    payload = sel.inside(geometry).to_ir()

    assert payload["kind"] == "inside_geometry"
    assert payload["geometry"]["kind"] in {
        "box",
        "cylinder",
        "sphere",
        "union",
        "intersection",
        "difference",
        "affine",
    }


def test_selection_scalar_and_boundary_validation_is_fail_closed() -> None:
    with pytest.raises(ValueError, match="lower"):
        sel.between(sel.m.x, 1.0, -1.0)
    with pytest.raises(ValueError, match="axis"):
        sel.m.dot((0.0, 0.0, 0.0))
    with pytest.raises(ValueError, match="tolerance"):
        sel.inside(
            fm.shapes.disk(radius=25e-9, thickness=3e-9),
            absolute_tolerance_m=-1.0,
        )
