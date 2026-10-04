from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

import fullmag as fm
from fullmag.model.canonical import (
    canonical_authoring_json_sha256,
    canonical_json_sha256,
)


def _problem(
    *,
    display_unit: str = "nm",
    model_name: str = "projection-film",
    component_name: str = "film",
    geometry_name: str = "film",
) -> fm.Problem:
    parameters = fm.ParameterLibrary()
    parameters.define(
        "film_width",
        fm.ParameterExpression.constant(250.0, unit="nm"),
        display_unit=display_unit,
    )
    return fm.Problem(
        name=model_name,
        magnets=[
            fm.Ferromagnet(
                name=component_name,
                object_id="component-film",
                geometry=fm.Box(
                    size=(250e-9, 50e-9, 5e-9),
                    name=geometry_name,
                ),
                material=fm.Material(name="Py", Ms=800e3, A=13e-12, alpha=0.01),
            )
        ],
        energy=[fm.Exchange(), fm.Demag()],
        study=fm.TimeEvolution(
            dynamics=fm.LLG(),
            outputs=[fm.SaveScalar("E_total", every=1e-12)],
        ),
        parameters=parameters,
    )


def test_problem_projects_typed_model_component_and_physics_contract() -> None:
    model = _problem().to_model_definition(model_id="model:projection")

    assert isinstance(model, fm.ModelDefinition)
    assert model.model_id == "model:projection"
    assert [component.component_id for component in model.components] == [
        "component-film"
    ]
    component = model.components[0]
    assert component.material_ref == "Py"
    assert component.geometry["kind"] == "box"
    assert component.to_ir()["initial_state"] == {
        "kind": "uniform",
        "value": [1.0, 0.0, 0.0],
    }

    assert len(model.physics_configurations) == 1
    physics = model.physics_configurations[0]
    assert physics.configuration_id == "physics:default"
    assert physics.active_interaction_kinds == ("demag", "exchange")
    assert [term["kind"] for term in physics.energy_terms] == ["exchange", "demag"]

    payload = model.to_ir()
    assert payload["schema_version"] == "authoring_model.v1"
    assert payload["components"][0]["component_id"] == "component-film"
    assert payload["physics_configurations"][0]["configuration_id"] == "physics:default"


def test_model_projection_is_read_only_and_does_not_share_nested_mutability() -> None:
    model = _problem().to_model_definition()

    with pytest.raises(TypeError):
        model.components[0].geometry["kind"] = "sphere"  # type: ignore[index]

    payload = model.to_ir()
    payload["components"][0]["geometry"]["kind"] = "sphere"
    assert model.components[0].geometry["kind"] == "box"


def test_model_projection_keeps_display_units_out_of_numerical_identity() -> None:
    first = _problem(display_unit="nm").to_model_definition()
    second = _problem(display_unit="um").to_model_definition()

    assert first.parameters != second.parameters
    assert first.parameter_numerical_sha256 == second.parameter_numerical_sha256
    assert first.numerical_sha256() == second.numerical_sha256()


def test_model_projection_keeps_display_names_out_of_numerical_identity() -> None:
    original = _problem().to_model_definition(model_id="model:stable")
    renamed = _problem(
        model_name="Renamed problem",
        component_name="Renamed film",
        geometry_name="Renamed box",
    ).to_model_definition(model_id="model:stable")

    assert original.to_ir() != renamed.to_ir()
    assert original.canonical_sha256() != renamed.canonical_sha256()
    assert original.numerical_sha256() == renamed.numerical_sha256()


def test_model_projection_rejects_duplicate_component_ids() -> None:
    component = fm.ComponentDefinition(
        component_id="component-a",
        name="a",
        geometry={"kind": "box"},
        material_ref="Py",
    )
    with pytest.raises(ValueError, match="unique component_id"):
        fm.ModelDefinition(
            model_id="model:test",
            name="test",
            components=(component, replace(component, name="b")),
            physics_configurations=(),
        )


def test_problem_projection_preserves_parameter_payload_without_materializing_runtime() -> None:
    model = _problem().to_model_definition()

    assert model.parameters is not None
    assert model.parameters["schema_version"] == "parameter_library.v1"
    assert model.parameters["parameters"][0]["id"] == "film_width"
    assert model.discretization is None
    assert model.couplings == ()


def test_model_projection_wire_roundtrip_preserves_versions_and_identity() -> None:
    original = _problem().to_model_definition(model_id="model:wire")

    restored = fm.ModelDefinition.from_ir(original.to_ir())

    assert restored == original
    assert restored.to_ir() == original.to_ir()
    assert restored.numerical_sha256() == original.numerical_sha256()
    assert restored.canonical_sha256() == original.canonical_sha256()


def test_model_projection_canonical_wire_hash_is_independent_of_mapping_order() -> None:
    original = _problem().to_model_definition(model_id="model:canonical")
    payload = original.to_ir()
    reordered = {
        "parameter_numerical_sha256": payload["parameter_numerical_sha256"],
        "parameters": payload["parameters"],
        "discretization": payload["discretization"],
        "couplings": payload["couplings"],
        "physics_configurations": payload["physics_configurations"],
        "components": payload["components"],
        "name": payload["name"],
        "model_id": payload["model_id"],
        "schema_version": payload["schema_version"],
    }

    assert canonical_json_sha256(payload) == canonical_json_sha256(reordered)
    assert original.canonical_sha256() == canonical_authoring_json_sha256(reordered)


def test_authoring_model_canonical_hash_matches_shared_rust_fixture() -> None:
    repository_root = Path(__file__).resolve().parents[3]
    fixture_root = repository_root / "crates" / "fullmag-authoring" / "tests" / "fixtures"
    payload = json.loads(
        (fixture_root / "authoring_model_canonical.json").read_text(encoding="utf-8")
    )
    expected_sha256 = (
        fixture_root / "authoring_model_canonical.sha256"
    ).read_text(encoding="ascii").strip()

    model = fm.ModelDefinition.from_ir(payload)

    assert model.canonical_sha256() == expected_sha256


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("schema_version", "authoring_model.v0"),
        ("unknown", True),
    ],
)
def test_model_projection_wire_parser_rejects_wrong_version_and_unknown_fields(
    field: str, value: object
) -> None:
    payload = _problem().to_model_definition().to_ir()
    payload[field] = value

    with pytest.raises(ValueError, match="schema_version|unknown fields"):
        fm.ModelDefinition.from_ir(payload)


def test_model_projection_wire_parser_rejects_nested_schema_mismatch() -> None:
    payload = _problem().to_model_definition().to_ir()
    payload["components"][0]["schema_version"] = "component_definition.v0"  # type: ignore[index]

    with pytest.raises(ValueError, match="component.schema_version"):
        fm.ModelDefinition.from_ir(payload)
