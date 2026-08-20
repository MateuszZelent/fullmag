from __future__ import annotations

from hashlib import sha256
import json
from numbers import Real
import struct
from typing import Mapping, Sequence

from ._selection_wire import (
    _GeometryExpr,
    _ParsedSelectionDefinition,
    _SCHEMA_VERSION,
    _ScalarExpr,
    _SelectionExpr,
    _parse_definition_ir,
    _real,
    _serialize,
)


def _node_metrics(value: object) -> tuple[int, int, int]:
    if not isinstance(value, (_SelectionExpr, _ScalarExpr, _GeometryExpr)):
        return (0, 0, 0)
    nodes = 1
    references = 1 if isinstance(value, _SelectionExpr) and value.kind == "ref" else 0
    child_depth = 0
    for _, child in value.fields:
        children = child if isinstance(child, tuple) else (child,)
        for nested in children:
            child_nodes, child_references, depth = _node_metrics(nested)
            nodes += child_nodes
            references += child_references
            child_depth = max(child_depth, depth)
    return nodes, references, 1 + child_depth


def _iter_references(expression: _SelectionExpr):
    if expression.kind == "ref":
        yield dict(expression.fields)["selection_id"]
        return
    for _, child in expression.fields:
        children = child if isinstance(child, tuple) else (child,)
        for nested in children:
            if isinstance(nested, _SelectionExpr):
                yield from _iter_references(nested)


def _contains_imported_solid(value: object) -> bool:
    if isinstance(value, _GeometryExpr) and value.kind == "imported_solid":
        return True
    if isinstance(value, (_SelectionExpr, _ScalarExpr, _GeometryExpr)):
        return any(
            _contains_imported_solid(nested)
            for _, child in value.fields
            for nested in (child if isinstance(child, tuple) else (child,))
        )
    return False


def _validate_definition_graph(
    definitions: Mapping[str, _ParsedSelectionDefinition],
) -> None:
    for definition in definitions.values():
        nodes, references, depth = _node_metrics(definition.expression)
        if depth > 64 or nodes > 4096 or references > 1024:
            raise ValueError("selection_complexity_exceeded")
        if _contains_imported_solid(definition.expression):
            raise ValueError("selection_imported_solid_unqualified")
        for reference in _iter_references(definition.expression):
            if reference not in definitions:
                raise ValueError(f"selection_unknown_reference: {reference!r}")

    memo: dict[str, tuple[int, int, int]] = {}

    def expanded(selection_id: str, visiting: set[str]) -> tuple[int, int, int]:
        if selection_id in memo:
            return memo[selection_id]
        if selection_id in visiting:
            raise ValueError(f"selection_reference_cycle: {selection_id!r}")
        visiting.add(selection_id)

        def walk(value: object) -> tuple[int, int, int]:
            if not isinstance(value, (_SelectionExpr, _ScalarExpr, _GeometryExpr)):
                return (0, 0, 0)
            if isinstance(value, _SelectionExpr) and value.kind == "ref":
                target = expanded(dict(value.fields)["selection_id"], visiting)
                return (1 + target[0], 1 + target[1], 1 + target[2])
            nodes = 1
            references = 0
            child_depth = 0
            for _, child in value.fields:
                children = child if isinstance(child, tuple) else (child,)
                for nested in children:
                    child_nodes, child_references, depth = walk(nested)
                    nodes += child_nodes
                    references += child_references
                    child_depth = max(child_depth, depth)
            return nodes, references, 1 + child_depth

        metrics = walk(definitions[selection_id].expression)
        visiting.remove(selection_id)
        memo[selection_id] = metrics
        return metrics

    for selection_id in definitions:
        nodes, references, depth = expanded(selection_id, set())
        if depth > 64 or nodes > 4096 or references > 1024:
            raise ValueError("selection_complexity_exceeded")


def _canonical_selection_sha256(
    definition: Mapping[str, object],
    *,
    dependencies: Sequence[Mapping[str, object]] = (),
) -> str:
    """Hash one named selection and every reachable named dependency."""

    by_id: dict[str, _ParsedSelectionDefinition] = {}
    for index, candidate in enumerate((*dependencies, definition)):
        parsed = _parse_definition_ir(candidate, f"selection definitions[{index}]")
        selection_id = parsed.selection_id
        if selection_id in by_id:
            raise ValueError(f"duplicate selection id {selection_id!r}")
        by_id[selection_id] = parsed

    root_id = _parse_definition_ir(definition, "root selection").selection_id
    _validate_definition_graph(by_id)
    reachable: set[str] = set()
    visiting: set[str] = set()

    def visit(selection_id: str) -> None:
        if selection_id in reachable:
            return
        if selection_id in visiting:
            raise ValueError(f"selection reference cycle at {selection_id!r}")
        candidate = by_id[selection_id]
        visiting.add(selection_id)
        for reference in _iter_references(candidate.expression):
            visit(reference)
        visiting.remove(selection_id)
        reachable.add(selection_id)

    visit(root_id)
    payload = {
        "hash_encoding": "selection_hash.f64_bits.v1",
        "schema_version": _SCHEMA_VERSION,
        "root_id": root_id,
        "definitions": [
            {
                "schema_version": _SCHEMA_VERSION,
                "id": selection_id,
                "expression": _serialize(by_id[selection_id].expression),
            }
            for selection_id in sorted(reachable)
        ],
    }
    encoded = json.dumps(
        _canonical_hash_numbers(payload),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return sha256(encoded.encode("utf-8")).hexdigest()


def _canonical_hash_numbers(value: object) -> object:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, Real):
        normalized = _real(value, "selection hash number")
        return {"$fullmag_f64_bits": struct.pack(">d", normalized).hex()}
    if isinstance(value, list):
        return [_canonical_hash_numbers(child) for child in value]
    if isinstance(value, Mapping):
        return {key: _canonical_hash_numbers(child) for key, child in value.items()}
    raise TypeError(
        f"selection hash payload contains unsupported value {type(value).__name__}"
    )
