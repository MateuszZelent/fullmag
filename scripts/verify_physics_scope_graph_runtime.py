#!/usr/bin/env python3
"""Fail-closed comparison for the physics-scope graph runtime contract.

The existing authoring/planner tests prove that a graph can be normalized and
that semantic marker/mask identities can be derived.  They do not compare a
captured graph with a runtime resolution.  This verifier is the small bridge
for that qualification step.  It intentionally accepts JSON only; managed
FEM/FDM recipes remain responsible for producing the JSON and this script does
not claim that a semantic fixture is a solver run.

Runtime payload schema (``fullmag.physics_scope_graph_runtime.v1``)::

    {
      "graph": {"schema_version": "physics_graph.v1", ...},
      "lanes": {
        "fem": {
          "modules": [{"module_id": ..., "status": ..., "scope_key": ...,
                       "depends_on": ..., "fem_marker_ids": ...}],
          "executed_module_ids": [...],
          "provenance": {"scene_revision": 3, "requested_lane": "fem",
                         "resolved_lane": "fem"}
        }
      }
    }

The resolved module list is deliberately required to include inactive and
blocked records.  That makes an authored zero-drive module distinguishable
from an absent one, while ``executed_module_ids`` proves dependency omission.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = REPO_ROOT / "crates/fullmag-authoring/tests/fixtures/physics_graph"
GRAPH_SCHEMA = "physics_graph.v1"
RUNTIME_SCHEMA = "fullmag.physics_scope_graph_runtime.v1"
ALLOWED_STATUSES = {
    "configured",
    "active",
    "inactive",
    "blocked",
    "unsupported",
    "unresolved",
}


class QualificationError(ValueError):
    """Raised when graph or runtime evidence does not satisfy the contract."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise QualificationError(message)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    _require(isinstance(value, Mapping), f"{label} must be an object")
    return value


def _list(value: Any, label: str) -> Sequence[Any]:
    _require(isinstance(value, list), f"{label} must be an array")
    return value


def _string(value: Any, label: str) -> str:
    _require(isinstance(value, str) and bool(value.strip()), f"{label} must be a non-empty string")
    return value


def _scope_key(scope: Mapping[str, Any]) -> str:
    kind = scope.get("kind")
    if kind == "global":
        return "global"
    if kind == "object":
        return f"object:{scope.get('object_id', 'unresolved')}"
    if kind == "region":
        return f"region:{scope.get('object_id', 'unresolved')}:{scope.get('region_id', 'unresolved')}"
    if kind == "cross_object":
        object_ids = scope.get("object_ids", [])
        if not isinstance(object_ids, list):
            return "cross_object:unresolved"
        ids = sorted(str(item) for item in object_ids)
        return f"cross_object:{','.join(ids)}"
    if kind == "interface":
        sides = []
        for side_name in ("side_a", "side_b"):
            side = scope.get(side_name)
            if isinstance(side, Mapping):
                sides.append(
                    f"{side.get('object_id', 'unresolved')}:{side.get('region_id') or '*'}"
                )
            else:
                sides.append("unresolved")
        return f"interface:{'<->'.join(sorted(sides))}"
    if kind == "unresolved":
        return "unresolved"
    return "unresolved"


def _applies_to_key(value: Any, label: str) -> str:
    scopes = _list(value, label)
    if not scopes:
        return "global"
    keys = sorted({_scope_key(_mapping(scope, f"{label}[]")) for scope in scopes})
    return "+".join(keys)


def _expected_scope_key(module: Mapping[str, Any], label: str) -> str | None:
    expected = module.get("scope")
    if expected is None:
        return None
    return _scope_key(_mapping(expected, f"{label}.scope"))


def _module_id(module: Mapping[str, Any], label: str) -> str:
    return _string(module.get("id", module.get("module_id")), f"{label}.id")


def _module_status(module: Mapping[str, Any], label: str) -> str:
    status = _string(
        module.get("activation", module.get("status")),
        f"{label}.activation",
    )
    _require(status in ALLOWED_STATUSES, f"{label}.activation has unknown value '{status}'")
    return status


def load_json(path: Path) -> Mapping[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise QualificationError(f"cannot read JSON {path}: {error}") from error
    return _mapping(payload, str(path))


def load_fixture(path_or_id: str | Path) -> Mapping[str, Any]:
    candidate = Path(path_or_id)
    if not candidate.is_absolute():
        by_id = FIXTURE_ROOT / f"{candidate}.json"
        candidate = by_id if by_id.is_file() else REPO_ROOT / candidate
    fixture = load_json(candidate)
    _string(fixture.get("id"), "fixture.id")
    _mapping(fixture.get("scene"), "fixture.scene")
    _list(fixture.get("expected_modules"), "fixture.expected_modules")
    _list(fixture.get("expected_edges"), "fixture.expected_edges")
    _list(fixture.get("expected_explorer_groups"), "fixture.expected_explorer_groups")
    return fixture


def validate_fixture_schema(fixture: Mapping[str, Any]) -> None:
    """Check the fixture side of the comparison before accepting evidence."""

    modules = _list(fixture.get("expected_modules"), "fixture.expected_modules")
    ids: set[str] = set()
    for index, raw in enumerate(modules):
        module = _mapping(raw, f"fixture.expected_modules[{index}]")
        module_id = _module_id(module, f"fixture.expected_modules[{index}]")
        _require(module_id not in ids, f"fixture has duplicate expected module '{module_id}'")
        ids.add(module_id)
        _string(module.get("kind"), f"fixture.expected_modules[{index}].kind")
        _module_status(module, f"fixture.expected_modules[{index}]")
        dependencies = module.get("depends_on", [])
        _list(dependencies, f"fixture.expected_modules[{index}].depends_on")
        for dependency in dependencies:
            _string(dependency, f"fixture.expected_modules[{index}].depends_on[]")
        if "scope" in module:
            _scope_key(_mapping(module["scope"], f"fixture.expected_modules[{index}].scope"))

    edges = _list(fixture.get("expected_edges"), "fixture.expected_edges")
    edge_keys: set[tuple[str, str, str, str]] = set()
    for index, raw in enumerate(edges):
        edge = _mapping(raw, f"fixture.expected_edges[{index}]")
        key = tuple(
            _string(edge.get(field), f"fixture.expected_edges[{index}].{field}")
            for field in ("kind", "source_id", "target_id", "status")
        )
        _require(key not in edge_keys, f"fixture has duplicate expected edge {key}")
        edge_keys.add(key)


def _fixture_modules(fixture: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    return {
        _module_id(module, "fixture.expected_modules[]"): _mapping(module, "fixture module")
        for module in _list(fixture["expected_modules"], "fixture.expected_modules")
    }


def _graph_modules(graph: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    modules = _list(graph.get("modules"), "graph.modules")
    result: dict[str, Mapping[str, Any]] = {}
    for index, raw in enumerate(modules):
        module = _mapping(raw, f"graph.modules[{index}]")
        module_id = _module_id(module, f"graph.modules[{index}]")
        _require(module_id not in result, f"graph contains duplicate module '{module_id}'")
        result[module_id] = module
    return result


def validate_graph(fixture: Mapping[str, Any], graph: Mapping[str, Any]) -> None:
    """Compare IDs, activation, scope and edges against a fixture."""

    validate_fixture_schema(fixture)
    _require(graph.get("schema_version") == GRAPH_SCHEMA, "graph.schema_version must be physics_graph.v1")
    scene = _mapping(fixture["scene"], "fixture.scene")
    _require(
        graph.get("scene_revision") == scene.get("revision"),
        "graph.scene_revision does not match fixture scene revision",
    )
    expected = _fixture_modules(fixture)
    actual = _graph_modules(graph)
    _require(set(actual) == set(expected), f"graph module IDs differ: expected {sorted(expected)}, got {sorted(actual)}")

    for module_id, expected_module in expected.items():
        module = actual[module_id]
        label = f"graph.modules[{module_id}]"
        _require(module.get("kind") == expected_module.get("kind"), f"{label}.kind differs")
        _require(_module_status(module, label) == expected_module.get("activation"), f"{label}.activation differs")
        actual_scope = _applies_to_key(module.get("applies_to"), f"{label}.applies_to")
        expected_scope = _expected_scope_key(expected_module, f"fixture.expected_modules[{module_id}]")
        if expected_scope is not None:
            _require(actual_scope == expected_scope, f"{label}.scope differs: expected {expected_scope}, got {actual_scope}")
        actual_dependencies = module.get("depends_on")
        _list(actual_dependencies, f"{label}.depends_on")
        expected_dependencies = expected_module.get("depends_on", [])
        _require(
            sorted(actual_dependencies) == sorted(expected_dependencies),
            f"{label}.depends_on differs",
        )

    expected_edges = {
        tuple(edge[field] for field in ("kind", "source_id", "target_id", "status"))
        for edge in _list(fixture["expected_edges"], "fixture.expected_edges")
    }
    actual_edges = set()
    for index, raw in enumerate(_list(graph.get("edges"), "graph.edges")):
        edge = _mapping(raw, f"graph.edges[{index}]")
        actual_edges.add(
            tuple(_string(edge.get(field), f"graph.edges[{index}].{field}") for field in ("kind", "source_id", "target_id", "status"))
        )
    _require(actual_edges == expected_edges, f"graph edges differ: expected {sorted(expected_edges)}, got {sorted(actual_edges)}")

    # Active graph dependencies must be present and executable in the graph;
    # this is the semantic omission rule before a lane is considered.
    for module_id, module in actual.items():
        status = _module_status(module, f"graph.modules[{module_id}]")
        if status not in {"active", "configured"}:
            continue
        for dependency in module.get("depends_on", []):
            _require(dependency in actual, f"active graph module '{module_id}' depends on absent '{dependency}'")
            dependency_status = _module_status(actual[dependency], f"graph.modules[{dependency}]")
            _require(
                dependency_status in {"active", "configured"},
                f"active graph module '{module_id}' depends on non-active '{dependency}'",
            )


def _extract_graph(payload: Mapping[str, Any]) -> Mapping[str, Any]:
    graph = payload.get("graph", payload)
    return _mapping(graph, "runtime.graph")


def _extract_lane(payload: Mapping[str, Any], lane: str) -> Mapping[str, Any]:
    lanes = payload.get("lanes")
    if isinstance(lanes, Mapping):
        return _mapping(lanes.get(lane), f"runtime.lanes.{lane}")
    if payload.get("lane") == lane or payload.get("resolved_lane") == lane:
        return payload
    raise QualificationError(f"runtime payload has no '{lane}' lane")


def _provenance_revision(provenance: Mapping[str, Any]) -> int:
    # `scene_revision` is the canonical graph/API identity.  Accept the
    # provisional `graph_revision` spelling for captured artifacts made while
    # the runtime contract was being introduced, but never accept a mismatch.
    scene_revision = provenance.get("scene_revision")
    graph_revision = provenance.get("graph_revision")
    _require(
        scene_revision is not None or graph_revision is not None,
        "provenance.scene_revision (or graph_revision alias) is missing",
    )
    if scene_revision is not None and graph_revision is not None:
        _require(scene_revision == graph_revision, "provenance scene_revision and graph_revision differ")
    revision = scene_revision if scene_revision is not None else graph_revision
    _require(
        isinstance(revision, int) and not isinstance(revision, bool),
        "provenance.scene_revision must be an integer",
    )
    return revision


def _validate_concrete_realization(
    lane_payload: Mapping[str, Any],
    graph_modules: Mapping[str, Mapping[str, Any]],
    lane: str,
) -> None:
    """Validate the optional mesh/grid realization certificate.

    Older qualification captures do not carry this field and remain valid
    semantic fixtures.  When present, the certificate must make the
    resolved/executed boundary explicit and must not reuse semantic marker or
    mask IDs as concrete topology evidence.
    """

    raw = lane_payload.get("realization")
    if raw is None:
        return
    realization = _mapping(raw, f"runtime.{lane}.realization")
    _require(
        realization.get("schema_version") == "physics_graph.realization.v1",
        f"runtime.{lane}.realization.schema_version is unsupported",
    )
    _string(realization.get("topology_fingerprint"), f"runtime.{lane}.realization.topology_fingerprint")
    resolved = [
        _string(module_id, f"runtime.{lane}.realization.resolved_module_ids[]")
        for module_id in _list(
            realization.get("resolved_module_ids"),
            f"runtime.{lane}.realization.resolved_module_ids",
        )
    ]
    executed = [
        _string(module_id, f"runtime.{lane}.realization.executed_module_ids[]")
        for module_id in _list(
            realization.get("executed_module_ids", []),
            f"runtime.{lane}.realization.executed_module_ids",
        )
    ]
    _require(len(resolved) == len(set(resolved)), f"runtime.{lane}.realization.resolved_module_ids contains duplicates")
    _require(len(executed) == len(set(executed)), f"runtime.{lane}.realization.executed_module_ids contains duplicates")
    _require(set(executed).issubset(set(resolved)), f"runtime.{lane}.realization executed IDs are not resolved")
    for module_id in (*resolved, *executed):
        _require(module_id in graph_modules, f"runtime.{lane}.realization contains unknown module '{module_id}'")

    records = _list(realization.get("modules"), f"runtime.{lane}.realization.modules")
    by_id: dict[str, Mapping[str, Any]] = {}
    for index, raw_module in enumerate(records):
        module = _mapping(raw_module, f"runtime.{lane}.realization.modules[{index}]")
        module_id = _module_id(module, f"runtime.{lane}.realization.modules[{index}]")
        _require(module_id not in by_id, f"runtime.{lane}.realization has duplicate module '{module_id}'")
        _require(module_id in graph_modules, f"runtime.{lane}.realization contains unknown module '{module_id}'")
        by_id[module_id] = module
        state = _string(module.get("state"), f"runtime.{lane}.realization.modules[{index}].state")
        _require(state in {"semantic_only", "resolved", "executed"}, f"runtime.{lane}.realization module '{module_id}' has invalid state '{state}'")
        _string(module.get("topology_fingerprint"), f"runtime.{lane}.realization.modules[{index}].topology_fingerprint")
        cell_count = module.get("realized_cell_count")
        _require(isinstance(cell_count, int) and not isinstance(cell_count, bool) and cell_count >= 0, f"runtime.{lane}.realization module '{module_id}' has invalid realized_cell_count")
        if state == "semantic_only":
            _require(module_id not in resolved and module_id not in executed, f"semantic-only realization '{module_id}' is listed as resolved/executed")
            _require(not module.get("realized_fem_marker_ids"), f"semantic-only FEM realization '{module_id}' carries markers")
            _require(not module.get("realized_fdm_mask_digest"), f"semantic-only FDM realization '{module_id}' carries a mask digest")
            continue
        _require(module_id in resolved, f"resolved realization '{module_id}' is missing from resolved_module_ids")
        _require(cell_count > 0, f"resolved realization '{module_id}' has no selected cells/elements")
        if state == "executed":
            _require(module_id in executed, f"executed realization '{module_id}' is missing from executed_module_ids")
        if lane == "fem":
            marker_ids = module.get("realized_fem_marker_ids")
            _require(isinstance(marker_ids, list) and bool(marker_ids), f"resolved FEM realization '{module_id}' has no concrete marker IDs")
            _require(all(isinstance(marker, int) and not isinstance(marker, bool) and marker >= 0 for marker in marker_ids), f"resolved FEM realization '{module_id}' has non-numeric marker IDs")
            _require(not module.get("realized_fdm_mask_digest"), f"FEM realization '{module_id}' carries an FDM mask digest")
        else:
            mask_digest = module.get("realized_fdm_mask_digest")
            _require(isinstance(mask_digest, str) and bool(mask_digest), f"resolved FDM realization '{module_id}' has no concrete mask digest")
            _require(not module.get("realized_fem_marker_ids"), f"FDM realization '{module_id}' carries FEM markers")
    _require(set(by_id) == set(graph_modules), f"runtime.{lane}.realization module IDs differ from graph")
    _require(set(resolved) == {module_id for module_id, module in by_id.items() if module.get("state") in {"resolved", "executed"}}, f"runtime.{lane}.realization resolved IDs disagree with module states")
    _require(set(executed) == {module_id for module_id, module in by_id.items() if module.get("state") == "executed"}, f"runtime.{lane}.realization executed IDs disagree with module states")


def validate_runtime_lane(
    fixture: Mapping[str, Any],
    graph: Mapping[str, Any],
    lane_payload: Mapping[str, Any],
    lane: str,
) -> None:
    """Compare a lane resolution and fail closed on missing execution proof."""

    _require(lane in {"fem", "fdm"}, f"unsupported runtime lane '{lane}'")
    graph_modules = _graph_modules(graph)
    provenance = _mapping(lane_payload.get("provenance"), f"runtime.{lane}.provenance")
    _require(_provenance_revision(provenance) == graph.get("scene_revision"), f"runtime.{lane}.provenance.scene_revision differs")
    _require(provenance.get("requested_lane") not in (None, ""), f"runtime.{lane}.provenance.requested_lane is missing")
    _require(provenance.get("resolved_lane") == lane, f"runtime.{lane}.provenance.resolved_lane must be '{lane}'")

    records = _list(lane_payload.get("modules"), f"runtime.{lane}.modules")
    by_id: dict[str, Mapping[str, Any]] = {}
    for index, raw in enumerate(records):
        record = _mapping(raw, f"runtime.{lane}.modules[{index}]")
        module_id = _module_id(record, f"runtime.{lane}.modules[{index}]")
        _require(module_id not in by_id, f"runtime.{lane} has duplicate module '{module_id}'")
        by_id[module_id] = record
        status = _module_status(record, f"runtime.{lane}.modules[{index}]")
        _require(module_id in graph_modules, f"runtime.{lane} contains unknown module '{module_id}'")
        graph_module = graph_modules[module_id]
        graph_status = _module_status(graph_module, f"graph.modules[{module_id}]")
        if graph_status not in {"active", "configured"}:
            _require(status not in {"active", "configured"}, f"inactive graph module '{module_id}' was promoted to executable")
        _require(record.get("scope_key") == _applies_to_key(graph_module.get("applies_to"), f"graph.modules[{module_id}].applies_to"), f"runtime.{lane} module '{module_id}' scope differs")
        dependencies = record.get("depends_on")
        _list(dependencies, f"runtime.{lane}.modules[{index}].depends_on")
        _require(sorted(dependencies) == sorted(graph_module.get("depends_on", [])), f"runtime.{lane} module '{module_id}' dependencies differ")
        if status in {"active", "configured"}:
            if lane == "fem":
                marker_ids = record.get("fem_marker_ids")
                _require(isinstance(marker_ids, list) and bool(marker_ids), f"executable FEM module '{module_id}' has no fem_marker_ids")
                _require(not record.get("fdm_cell_mask_id"), f"FEM module '{module_id}' carries an FDM mask")
            else:
                _require(isinstance(record.get("fdm_cell_mask_id"), str) and bool(record["fdm_cell_mask_id"]), f"executable FDM module '{module_id}' has no fdm_cell_mask_id")
                _require(not record.get("fem_marker_ids"), f"FDM module '{module_id}' carries FEM markers")
        else:
            _require(not record.get("fem_marker_ids"), f"non-executable module '{module_id}' carries FEM markers")
            _require(not record.get("fdm_cell_mask_id"), f"non-executable module '{module_id}' carries an FDM mask")

    _require(set(by_id) == set(graph_modules), f"runtime.{lane} module IDs differ from graph: expected {sorted(graph_modules)}, got {sorted(by_id)}")
    executed = _list(lane_payload.get("executed_module_ids"), f"runtime.{lane}.executed_module_ids")
    executed_ids = [
        _string(module_id, f"runtime.{lane}.executed_module_ids[]") for module_id in executed
    ]
    _require(len(executed_ids) == len(set(executed_ids)), f"runtime.{lane}.executed_module_ids contains duplicates")
    for module_id in executed_ids:
        _require(module_id in by_id, f"runtime.{lane} executes unknown module '{module_id}'")
        status = _module_status(by_id[module_id], f"runtime.{lane}.modules[{module_id}]")
        _require(status in {"active", "configured"}, f"runtime.{lane} executes non-executable module '{module_id}'")
        for dependency in by_id[module_id].get("depends_on", []):
            _require(dependency in executed_ids, f"runtime.{lane} executes '{module_id}' without dependency '{dependency}'")
    _validate_concrete_realization(lane_payload, graph_modules, lane)


def validate_runtime_payload(fixture: Mapping[str, Any], payload: Mapping[str, Any], lanes: Sequence[str] = ("fem", "fdm")) -> None:
    """Validate graph and one or more lane payloads from a captured artifact."""

    _require(payload.get("schema_version") in {None, RUNTIME_SCHEMA}, "unexpected runtime qualification schema")
    graph = _extract_graph(payload)
    validate_graph(fixture, graph)
    for lane in lanes:
        lane_payload = _extract_lane(payload, lane)
        validate_runtime_lane(fixture, graph, lane_payload, lane)


def build_report(
    fixture: Mapping[str, Any],
    graph: Mapping[str, Any] | None,
    payload: Mapping[str, Any] | None,
    lanes: Sequence[str],
) -> dict[str, Any]:
    """Return a machine-readable result without upgrading physics status."""

    result: dict[str, Any] = {
        "schema_version": RUNTIME_SCHEMA,
        "status": "pass",
        "fixture_id": fixture["id"],
        "scene_revision": _mapping(fixture["scene"], "fixture.scene")["revision"],
        "qualification_boundary": {
            "graph_semantics": "pass",
            "runtime_execution": "not_proven",
            "physics": "not_qualified",
        },
    }
    if graph is not None:
        validate_graph(fixture, graph)
        result["graph_sha256"] = hashlib.sha256(
            json.dumps(graph, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
    if payload is not None:
        validate_runtime_payload(fixture, payload, lanes)
        result["qualification_boundary"]["runtime_execution"] = "reference_executable"
        result["lanes"] = list(lanes)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", required=True, help="fixture ID or path")
    parser.add_argument("--graph", type=Path, help="normalized physics_graph.v1 JSON")
    parser.add_argument("--runtime", type=Path, help="runtime qualification JSON")
    parser.add_argument("--lane", action="append", choices=("fem", "fdm"), dest="lanes")
    parser.add_argument("--output", type=Path, help="optional report path")
    args = parser.parse_args(argv)
    lanes = tuple(args.lanes or ("fem", "fdm"))
    try:
        fixture = load_fixture(args.fixture)
        graph = load_json(args.graph) if args.graph else None
        payload = load_json(args.runtime) if args.runtime else None
        if graph is None and payload is None:
            raise QualificationError("provide --graph or --runtime; no runtime proof is inferred")
        report = build_report(fixture, graph, payload, lanes)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2, sort_keys=True))
    except QualificationError as error:
        print(f"physics scope graph runtime qualification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
