from __future__ import annotations

import importlib
from pathlib import Path

import pytest

from fullmag.model import selection as selection_model


def _definition(selection_id: str, expression: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": "selection_expr.v1",
        "id": selection_id,
        "expression": expression,
    }


def _parsed_definitions(
    definitions: list[dict[str, object]],
) -> dict[str, object]:
    parsed = [
        selection_model._parse_definition_ir(definition, f"definitions[{index}]")
        for index, definition in enumerate(definitions)
    ]
    return {definition.selection_id: definition for definition in parsed}


def _reference_chain(length: int) -> list[dict[str, object]]:
    return [
        _definition(
            f"selection-{index}",
            (
                {"kind": "all_magnetic"}
                if index == length - 1
                else {"kind": "ref", "selection_id": f"selection-{index + 1}"}
            ),
        )
        for index in range(length)
    ]


def _node_definition(node_count: int) -> dict[str, object]:
    return _definition(
        "root",
        {
            "kind": "or",
            "expressions": [{"kind": "all_magnetic"} for _ in range(node_count - 1)],
        },
    )


def _reference_fanout(reference_count: int) -> list[dict[str, object]]:
    dependencies = [
        _definition(f"leaf-{index}", {"kind": "all_magnetic"})
        for index in range(reference_count)
    ]
    root = _definition(
        "root",
        {
            "kind": "or",
            "expressions": [
                {"kind": "ref", "selection_id": f"leaf-{index}"}
                for index in range(reference_count)
            ],
        },
    )
    return [*dependencies, root]


def test_selection_implementation_is_split_by_responsibility() -> None:
    wire = importlib.import_module("fullmag.model._selection_wire")
    validation = importlib.import_module("fullmag.model._selection_validation")

    assert selection_model._parse_definition_ir is wire._parse_definition_ir
    assert (
        selection_model._validate_definition_graph
        is validation._validate_definition_graph
    )
    assert validation._canonical_selection_sha256 is not None
    assert (
        len(Path(selection_model.__file__).read_text(encoding="utf-8").splitlines())
        < 800
    )


def test_definition_graph_rejects_unknown_reference() -> None:
    definitions = [_definition("root", {"kind": "ref", "selection_id": "missing"})]

    with pytest.raises(ValueError, match="selection_unknown_reference"):
        selection_model._validate_definition_graph(_parsed_definitions(definitions))
    with pytest.raises(ValueError, match="selection_unknown_reference"):
        selection_model.canonical_selection_sha256(definitions[0])


def test_definition_graph_rejects_reference_cycle() -> None:
    definitions = [
        _definition("a", {"kind": "ref", "selection_id": "b"}),
        _definition("b", {"kind": "ref", "selection_id": "a"}),
    ]

    with pytest.raises(ValueError, match="selection_reference_cycle"):
        selection_model._validate_definition_graph(_parsed_definitions(definitions))
    with pytest.raises(ValueError, match="selection_reference_cycle"):
        selection_model.canonical_selection_sha256(
            definitions[0], dependencies=definitions[1:]
        )


def test_definition_graph_accepts_64_and_rejects_65_expanded_depth() -> None:
    accepted = _reference_chain(64)
    rejected = _reference_chain(65)

    selection_model._validate_definition_graph(_parsed_definitions(accepted))
    assert (
        len(
            selection_model.canonical_selection_sha256(
                accepted[0], dependencies=accepted[1:]
            )
        )
        == 64
    )

    with pytest.raises(ValueError, match="selection_complexity_exceeded"):
        selection_model._validate_definition_graph(_parsed_definitions(rejected))
    with pytest.raises(ValueError, match="selection_complexity_exceeded"):
        selection_model.canonical_selection_sha256(
            rejected[0], dependencies=rejected[1:]
        )


def test_definition_graph_accepts_4096_and_rejects_4097_nodes() -> None:
    accepted = _node_definition(4096)
    rejected = _node_definition(4097)

    selection_model._validate_definition_graph(_parsed_definitions([accepted]))
    assert len(selection_model.canonical_selection_sha256(accepted)) == 64

    with pytest.raises(ValueError, match="selection_complexity_exceeded"):
        selection_model._validate_definition_graph(_parsed_definitions([rejected]))
    with pytest.raises(ValueError, match="selection_complexity_exceeded"):
        selection_model.canonical_selection_sha256(rejected)


def test_definition_graph_accepts_1024_and_rejects_1025_references() -> None:
    accepted = _reference_fanout(1024)
    rejected = _reference_fanout(1025)

    selection_model._validate_definition_graph(_parsed_definitions(accepted))
    assert (
        len(
            selection_model.canonical_selection_sha256(
                accepted[-1], dependencies=accepted[:-1]
            )
        )
        == 64
    )

    with pytest.raises(ValueError, match="selection_complexity_exceeded"):
        selection_model._validate_definition_graph(_parsed_definitions(rejected))
    with pytest.raises(ValueError, match="selection_complexity_exceeded"):
        selection_model.canonical_selection_sha256(
            rejected[-1], dependencies=rejected[:-1]
        )
