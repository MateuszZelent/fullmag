"""Authoring-only preservation of an explicit shared FEM domain source.

Owner assertions check the current model and never rewrite a source marker map.
They do not add historical ownership semantics to executable ProblemIR v0.3.
"""
from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any


def _text(value, label):
    if not isinstance(value, str) or not value or value.strip() != value or chr(0) in value:
        raise ValueError(f"{label} must be nonempty text without surrounding whitespace or NUL")
    return value


def _marker_table(value, label):
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a list")
    names, markers, result = set(), set(), []
    for row in value:
        if not isinstance(row, Mapping) or set(row) != {"geometry_name", "marker"}:
            raise ValueError(f"{label} entries require geometry_name and marker")
        name = _text(row["geometry_name"], label + ".geometry_name")
        marker = row["marker"]
        if type(marker) is not int or not 0 < marker <= 0xffffffff:
            raise ValueError(f"{label}.marker must be a positive u32")
        if name in names or marker in markers:
            raise ValueError(f"{label} contains duplicate names or markers")
        names.add(name)
        markers.add(marker)
        result.append({"geometry_name": name, "marker": marker})
    return result


def normalize_shared_domain_mesh_source(value: object) -> dict[str, object]:
    if not isinstance(value, Mapping):
        raise ValueError("shared_domain_mesh_source must be an object")
    if value.get("kind") == "generated":
        if set(value) != {"kind"}:
            raise ValueError("generated shared_domain_mesh_source has unexpected fields")
        return {"kind": "generated"}
    required = {"kind", "source", "region_markers", "marker_owners"}
    allowed = required | {"object_region_markers"}
    if value.get("kind") != "explicit" or not required <= set(value) or set(value) - allowed:
        raise ValueError("explicit shared_domain_mesh_source has missing or unknown fields")
    result = {"kind": "explicit", "source": _text(value["source"], "source"),
              "region_markers": _marker_table(value["region_markers"], "region_markers")}
    if "object_region_markers" in value:
        result["object_region_markers"] = _marker_table(value["object_region_markers"], "object_region_markers")
    rows = [(table, row) for table in ("region_markers", "object_region_markers")
            for row in result.get(table, [])]
    markers = [row["marker"] for _, row in rows]
    if len(markers) != len(set(markers)):
        raise ValueError("shared domain marker IDs collide between tables")
    owners = value["marker_owners"]
    if not isinstance(owners, list):
        raise ValueError("marker_owners must be a list")
    expected = {(table, row["geometry_name"], row["marker"]) for table, row in rows}
    seen, normalized = set(), []
    for owner in owners:
        if not isinstance(owner, Mapping) or set(owner) != {"table", "geometry_name", "marker", "target"}:
            raise ValueError("marker owner has missing or unknown fields")
        table = owner["table"]
        name = _text(owner["geometry_name"], "marker owner.geometry_name")
        marker = owner["marker"]
        if not isinstance(table, str) or table not in {"region_markers", "object_region_markers"} or type(marker) is not int:
            raise ValueError("invalid marker owner table or marker")
        key = (table, name, marker)
        if key not in expected or key in seen:
            raise ValueError("marker owner does not match exactly one source entry")
        target = owner["target"]
        if hasattr(target, "to_ir"):
            target = target.to_ir()
        if not isinstance(target, Mapping):
            raise ValueError("marker owner target must be a RegionRef")
        fields = {"object_id"} if table == "region_markers" else {"object_id", "region_id"}
        if set(target) != fields:
            raise ValueError("marker owner target has missing or unknown fields")
        normalized.append({"table": table, "geometry_name": name, "marker": marker,
                           "target": {key: _text(target[key], "marker owner." + key)
                                      for key in ("object_id", "region_id") if key in fields}})
        seen.add(key)
    if seen != expected:
        raise ValueError("marker owners must cover every source entry")
    result["marker_owners"] = normalized
    return result


def _workflow(problem):
    value = problem.runtime_metadata.get("mesh_workflow")
    return value if isinstance(value, Mapping) else {}


def _resolve_owner(table, key, geometries, regions):
    if table == "region_markers":
        matches = [owner for geometry, owner in geometries if geometry == key]
        if len(matches) != 1:
            raise ValueError(f"marker owner for geometry {key!r} is missing or ambiguous")
        return {"object_id": matches[0]}
    exact = [region for region in regions if region["region_id"] == key]
    matches = exact if exact else [region for region in regions if region["enabled"] and region["name"] == key]
    if len(matches) != 1 or not matches[0]["enabled"]:
        raise ValueError(f"marker owner for region {key!r} is missing, disabled or ambiguous")
    region = matches[0]
    if region["owner_object"] not in [owner for _, owner in geometries]:
        raise ValueError(f"marker owner {region['owner_object']!r} is absent")
    return {"object_id": region["owner_object"], "region_id": region["region_id"]}


def _current_owner(problem, table, key):
    geometries = [(magnet.geometry.geometry_name, magnet.object_id or magnet.name)
                  for magnet in problem.magnets]
    geometries += [(geometry.geometry_name, problem.auxiliary_geometry_object_ids.get(
                   geometry.geometry_name, geometry.geometry_name))
                   for geometry in problem.auxiliary_geometries]
    regions = [{"region_id": region.region_id, "name": region.name,
                "owner_object": region.owner_object, "enabled": region.enabled}
               for magnet in problem.magnets for region in magnet.object_regions]
    return _resolve_owner(table, key, geometries, regions)


def validate_scene_domain_marker_owners(value: object, objects: list[dict[str, object]]) -> dict[str, object]:
    source = normalize_shared_domain_mesh_source(value)
    if source["kind"] == "generated":
        return source
    geometries, regions = [], []
    for obj in objects:
        object_id = obj["id"]
        name = obj.get("name") or object_id
        geometry = obj.get("geometry") or {}
        key = geometry.get("geometry_name") or (
            name + "_geom" if obj.get("role", "magnet") == "magnet" else name)
        geometries.append((key, object_id))
        for region in obj.get("regions") or []:
            owner = region.get("owner_object") or object_id
            if owner != object_id:
                raise ValueError("marker owner differs from the region container")
            regions.append({"region_id": region.get("region_id"), "name": region.get("name"),
                            "owner_object": owner, "enabled": region.get("enabled", True)})
    for owner in source["marker_owners"]:
        if _resolve_owner(owner["table"], owner["geometry_name"], geometries, regions) != owner["target"]:
            raise ValueError(f"marker owner changed for {owner['geometry_name']!r}")
    return source


def capture_domain_marker_owners(problem: Any) -> list[dict[str, object]]:
    workflow = _workflow(problem)
    return [{"table": table, "geometry_name": row["geometry_name"], "marker": row["marker"],
             "target": _current_owner(problem, table, row["geometry_name"])}
            for table, field in (("region_markers", "domain_region_markers"),
                                 ("object_region_markers", "domain_object_region_markers"))
            for row in workflow.get(field, []) or []]


def source_from_problem(problem: Any) -> dict[str, object] | None:
    workflow = _workflow(problem)
    source = workflow.get("domain_mesh_source")
    if source is None:
        return None
    value = {"kind": "explicit", "source": source,
             "region_markers": copy.deepcopy(workflow.get("domain_region_markers")),
             "marker_owners": copy.deepcopy(workflow.get("domain_marker_owners", []))}
    if workflow.get("domain_object_region_markers") is not None:
        value["object_region_markers"] = copy.deepcopy(workflow["domain_object_region_markers"])
    return normalize_shared_domain_mesh_source(value)


def validate_domain_marker_owners(problem: Any, owners: object) -> None:
    workflow = _workflow(problem)
    value = {"kind": "explicit", "source": workflow.get("domain_mesh_source"),
             "region_markers": workflow.get("domain_region_markers"), "marker_owners": owners}
    if workflow.get("domain_object_region_markers") is not None:
        value["object_region_markers"] = workflow["domain_object_region_markers"]
    normalized = normalize_shared_domain_mesh_source(value)
    for owner in normalized["marker_owners"]:
        current = _current_owner(problem, owner["table"], owner["geometry_name"])
        if current != owner["target"]:
            raise ValueError(f"marker owner changed for {owner['geometry_name']!r}")


def accept_domain_mesh_source(problem: Any) -> None:
    """Capture legacy intent once, or check literal expectations on later edits."""
    workflow = _workflow(problem)
    if workflow.get("domain_mesh_source") is None:
        return
    if problem.runtime.backend_target.value == "fdm":
        raise ValueError("explicit domain mesh source requires FEM")
    if "domain_marker_owners" not in workflow:
        owners = capture_domain_marker_owners(problem)
        # This model snapshot owns its captured expectations; do not mutate a
        # caller's metadata or recompute owners after dataclasses.replace.
        metadata = copy.deepcopy(problem.runtime_metadata)
        metadata["mesh_workflow"]["domain_marker_owners"] = owners
        object.__setattr__(problem, "runtime_metadata", metadata)
    validate_domain_marker_owners(problem, _workflow(problem)["domain_marker_owners"])
