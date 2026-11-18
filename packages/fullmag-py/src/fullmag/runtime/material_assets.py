"""Non-executable material identities and source snapshots for script round trips.

The explicit DSL remains authoritative for every assigned material coefficient.
This metadata never looks up the catalog and never activates a physics module.
"""
from __future__ import annotations

import copy
import hashlib
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any

MATERIAL_ASSETS_VERSION = "fullmag.material-assets.v1"
_PROPERTY_KEYS = ("Ms", "Aex", "alpha", "Dind", "Dbulk")


def _mapping(value: object, context: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{context} must be an object")
    return value


def _text(value: object, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context} must be a nonempty string")
    return value


def _properties(value: object, context: str) -> dict[str, Any]:
    raw = _mapping(value, context)
    if "alpha" not in raw:
        raise ValueError(f"{context}.alpha is required")
    result = {}
    for key in _PROPERTY_KEYS:
        number = raw.get(key)
        if number is None and key != "alpha":
            result[key] = None
            continue
        try:
            finite = not isinstance(number, bool) and isinstance(number, (int, float)) and math.isfinite(number)
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError(f"{context}.{key} must be finite")
        if key in {"Ms", "Aex", "alpha"} and number < 0:
            raise ValueError(f"{context}.{key} must be nonnegative")
        result[key] = number
    return result


def _references(value: object, context: str, *, catalog_source: bool = False) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError(f"{context} must be a list")
    if catalog_source and len(value) > 64:
        raise ValueError(f"{context} supports at most 64 references")
    result = []
    for index, raw in enumerate(value):
        entry = _mapping(raw, f"{context}[{index}]")
        if set(entry) - {"label", "url", "citation"}:
            raise ValueError(f"{context}[{index}] has unsupported fields")
        if any(item is not None and not isinstance(item, str) for item in entry.values()):
            raise ValueError(f"{context}[{index}] values must be strings or null")
        if not catalog_source:
            result.append(dict(entry))
            continue
        for key, limit in (("label", 512), ("url", 4096), ("citation", 16384)):
            text = entry.get(key)
            if text is not None and len(text.encode("utf-8")) > limit:
                raise ValueError(f"{context}[{index}].{key} exceeds its size limit")
        url = entry.get("url")
        if url is not None:
            match = re.match(r"^https?://([^/?#]+)", url)
            if (not match or match[1].startswith(":") or any(
                    character.isspace() or ord(character) < 32 or 127 <= ord(character) <= 159 or character == "\\"
                    for character in url)):
                raise ValueError(f"{context}[{index}].url must use http or https with a valid host")
        result.append(copy.deepcopy(dict(entry)))
    return result


def _source(value: object, context: str) -> dict[str, Any]:
    raw = _mapping(value, context)
    if set(raw) - {"catalog_id", "catalog_revision", "name", "kind", "properties", "references"}:
        raise ValueError(f"{context} has unsupported fields")
    revision = raw.get("catalog_revision")
    if isinstance(revision, bool) or not isinstance(revision, int) or not 0 < revision <= 2**64 - 1:
        raise ValueError(f"{context}.catalog_revision must be a positive u64")
    if not isinstance(raw.get("kind"), str) or raw["kind"] not in {"builtin", "custom", "modified"}:
        raise ValueError(f"{context}.kind must be builtin, custom, or modified")
    catalog_id = _text(raw.get("catalog_id"), f"{context}.catalog_id")
    expected_prefix = "builtin:" if raw["kind"] == "builtin" else "custom:"
    if len(catalog_id.encode("utf-8")) > 160 or not re.fullmatch(r"[A-Za-z0-9:_-]+", catalog_id):
        raise ValueError(f"{context}.catalog_id contains invalid characters or exceeds its size limit")
    if not catalog_id.startswith(expected_prefix):
        raise ValueError(f"{context}.catalog_id and kind disagree")
    name = _text(raw.get("name"), f"{context}.name")
    if len(name) > 240:
        raise ValueError(f"{context}.name exceeds its size limit")
    properties = _properties(raw.get("properties"), f"{context}.properties")
    if properties["Ms"] is not None and properties["Ms"] <= 0:
        raise ValueError(f"{context}.properties.Ms must be positive or null")
    return {
        "catalog_id": catalog_id,
        "catalog_revision": revision,
        "name": name,
        "kind": raw["kind"],
        "properties": properties,
        "references": _references(raw.get("references", []), f"{context}.references", catalog_source=True),
    }


_DMI_KINDS = {"Dind": "interfacial_dmi", "Dbulk": "bulk_dmi"}


def _interactions_by_kind(stack: Sequence[Mapping[str, Any]]) -> dict[str, Mapping[str, Any]]:
    return {str(entry.get("kind")): entry for entry in stack if isinstance(entry, Mapping)}


def _inactive_dmi(stack: Sequence[Mapping[str, Any]]) -> list[str]:
    interactions = _interactions_by_kind(stack)
    return [key for key, kind in _DMI_KINDS.items()
            if interactions.get(kind, {}).get("enabled") is False]


def canonical_material_assets(value: object) -> dict[str, Any]:
    context = "material_assets"
    raw = _mapping(value, context)
    if raw.get("version") != MATERIAL_ASSETS_VERSION:
        raise ValueError(f"{context}.version must be {MATERIAL_ASSETS_VERSION}")
    dmi_metadata_fields = ("inactive_dmi", "active_dmi_without_coefficient")
    if set(raw) - {"version", "materials", "assignments", "object_ids", *dmi_metadata_fields}:
        raise ValueError(f"{context} has unsupported fields")
    entries = raw.get("materials")
    if not isinstance(entries, list):
        raise ValueError(f"{context}.materials must be a list")
    if len(entries) > 10000:
        raise ValueError(f"{context}.materials exceeds its item limit")
    materials = []
    identities = set()
    for index, value in enumerate(entries):
        label = f"{context}.materials[{index}]"
        entry = _mapping(value, label)
        if set(entry) - {"id", "name", "properties", "references", "source"}:
            raise ValueError(f"{label} has unsupported fields")
        identity = _text(entry.get("id"), f"{label}.id")
        if identity in identities:
            raise ValueError(f"{context} contains duplicate material ID {identity!r}")
        identities.add(identity)
        name = entry.get("name")
        if not isinstance(name, str):
            raise ValueError(f"{label}.name must be a string")
        material = {
            "id": identity,
            "name": name,
            "properties": _properties(entry.get("properties"), f"{label}.properties"),
            "references": _references(entry.get("references", []), f"{label}.references"),
        }
        if entry.get("source") is not None:
            material["source"] = _source(entry["source"], f"{label}.source")
        materials.append(material)
    raw_assignments = _mapping(raw.get("assignments"), f"{context}.assignments")
    raw_object_ids = _mapping(raw.get("object_ids"), f"{context}.object_ids")
    if len(raw_assignments) > 10000 or len(raw_object_ids) > 10000:
        raise ValueError(f"{context} exceeds its item limit")
    assignments = {}
    for object_id, material_id in raw_assignments.items():
        object_id = _text(object_id, f"{context}.assignments object ID")
        material_id = _text(material_id, f"{context}.assignments[{object_id!r}]")
        if material_id not in identities:
            raise ValueError(f"{context}.assignments references missing material {material_id!r}")
        assignments[object_id] = material_id
    object_ids = {}
    for name, object_id in raw_object_ids.items():
        name = _text(name, f"{context}.object_ids geometry name")
        object_id = _text(object_id, f"{context}.object_ids[{name!r}]")
        if object_id in object_ids.values():
            raise ValueError(f"{context}.object_ids contains duplicate object ID {object_id!r}")
        object_ids[name] = object_id
    result = {"version": MATERIAL_ASSETS_VERSION, "materials": materials, "assignments": assignments,
              "object_ids": object_ids}
    for field in dmi_metadata_fields:
        flags = {}
        for object_id, values in _mapping(raw.get(field, {}), f"{context}.{field}").items():
            if (object_id not in assignments or not isinstance(values, list)
                    or any(not isinstance(value, str) or value not in _DMI_KINDS for value in values)
                    or len(values) != len(set(values))):
                raise ValueError(f"{context}.{field} has invalid object or coefficient")
            if values:
                flags[object_id] = [key for key in _DMI_KINDS if key in values]
        if flags:
            result[field] = flags
    return result


def material_assets_from_scene(scene: Mapping[str, Any]) -> dict[str, Any]:
    """Capture independent assets, including unassigned entries, by immutable ID."""
    materials = scene.get("materials") or []
    by_id = {entry["id"]: entry["properties"] for entry in materials}
    active_without_coefficient = {}
    for obj in scene.get("objects") or []:
        properties = by_id.get(obj.get("material_ref"))
        if properties is None or str(obj.get("role") or "magnet") != "magnet":
            continue
        physics = _interactions_by_kind(obj.get("physics_stack") or [])
        if fields := [key for key, kind in _DMI_KINDS.items() if properties.get(key) is None
                      and (term := physics.get(kind)) is not None and term.get("enabled", True)
                      and (term.get("params") or {}).get(key.lower()) == 0]:
            active_without_coefficient[obj["id"]] = fields
    return canonical_material_assets({
        "version": MATERIAL_ASSETS_VERSION,
        "materials": materials,
        "active_dmi_without_coefficient": active_without_coefficient,
        "object_ids": {
            str(obj.get("name") or obj["id"]).strip(): obj["id"]
            for obj in scene.get("objects") or []
            if str(obj.get("role") or "magnet") == "magnet"
        },
        "assignments": {
            obj["id"]: obj["material_ref"]
            for obj in scene.get("objects") or []
            if str(obj.get("role") or "magnet") == "magnet"
        },
        "inactive_dmi": {
            obj["id"]: inactive for obj in scene.get("objects") or []
            if str(obj.get("role") or "magnet") == "magnet"
            and (inactive := _inactive_dmi(obj.get("physics_stack") or []))
        },
    })


def restore_inactive_material_dmi(
    metadata: Mapping[str, Any], geometries: Sequence[dict[str, Any]],
) -> None:
    """Restore dormant coefficients omitted by the executable Python API."""
    inactive_dmi = metadata.get("inactive_dmi") or {}
    if not inactive_dmi:
        return
    entries = {entry["id"]: entry["properties"] for entry in metadata["materials"]}
    for geometry in geometries:
        object_id = geometry.get("object_id") or metadata["object_ids"].get(geometry.get("name"))
        keys = inactive_dmi.get(object_id)
        if not keys:
            continue
        material = geometry["material"]
        stack = list(geometry.get("physics_stack") or [])
        geometry["physics_stack"] = stack
        original = entries[metadata["assignments"][object_id]]
        for key in keys:
            kind = _DMI_KINDS[key]
            if material.get(key) is not None or any(
                entry.get("enabled", True) and (entry.get("kind") == kind
                    or (key == "Dind" and entry.get("kind") == "rotated_interfacial_dmi"))
                for entry in stack
            ):
                continue
            material[key] = original[key]
            if not any(entry.get("kind") == kind for entry in stack):
                stack.append({"kind": kind, "enabled": False, "params": {key.lower(): original[key] or 0.0}})


def reconcile_material_assets(value: object, geometries: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Merge current DSL coefficients into identity metadata without overwriting them.

    A human may edit just one member of a formerly shared material. Such a
    divergence creates a deterministic independent asset with the same source.
    Deleted objects may leave unassigned materials; new objects have no source.
    """
    metadata = canonical_material_assets(value)
    materials = metadata["materials"]
    by_id = {entry["id"]: entry for entry in materials}
    previous_assignments = metadata["assignments"]
    groups: dict[str, dict[tuple[Any, ...], list[tuple[str, dict[str, Any]]]]] = {}
    assignments = {}
    object_ids = {}
    inactive = {}
    active_without_coefficient = {}
    for geometry in geometries:
        if str(geometry.get("role") or "magnet") != "magnet":
            continue
        name = str(geometry.get("name") or geometry.get("object_id") or "")
        object_id = _text(
            geometry.get("object_id") or metadata["object_ids"].get(name) or name,
            "material_assets object ID",
        )
        if name in object_ids:
            raise ValueError(f"material_assets contains duplicate geometry name {name!r}")
        object_ids[name] = object_id
        if object_id in assignments:
            raise ValueError(f"material_assets contains duplicate object ID {object_id!r}")
        properties = _properties(geometry.get("material"), f"material_assets object {object_id!r}.properties")
        material_id = previous_assignments.get(object_id)
        if material_id is None:
            name = str(geometry.get("name") or object_id)
            stem = f"mat:{name}"
            candidate = stem
            suffix = 1
            while candidate in by_id:
                candidate = f"{stem}:{suffix}"
                suffix += 1
            by_id[candidate] = {
                "id": candidate, "name": f"{name} material", "properties": properties, "references": [],
            }
            materials.append(by_id[candidate])
            assignments[object_id] = candidate
            continue
        assignments[object_id] = material_id
        # An inactive zero DMI coefficient has no executable DSL assignment:
        # assigning zero there would register an explicit DMI interaction.
        # Preserve only this authoring-only zero from editable asset metadata.
        # Explicit DSL coefficients always win; absent nonzero coefficients
        # are never restored, and source baselines never supply live values.
        enabled_kinds = {
            term.get("kind") for term in geometry.get("physics_stack") or []
            if isinstance(term, Mapping) and term.get("enabled", True) is not False
        }
        original = by_id[material_id]
        for key, kind in _DMI_KINDS.items():
            saved = original["properties"][key]
            if (key in metadata.get("active_dmi_without_coefficient", {}).get(object_id, ())
                    and properties[key] in (None, 0) and kind in enabled_kinds):
                # The script needs an executable zero to preserve an enabled
                # interaction. The catalog copy still has an unset coefficient.
                properties[key] = None
                active_without_coefficient.setdefault(object_id, []).append(key)
            elif (properties[key] is None and saved == 0 and kind not in enabled_kinds
                    and not (key == "Dind" and "rotated_interfacial_dmi" in enabled_kinds)):
                properties[key] = 0.0
        if flags := _inactive_dmi(geometry.get("physics_stack") or []):
            inactive[object_id] = flags
        signature = tuple(properties[key] for key in _PROPERTY_KEYS)
        groups.setdefault(material_id, {}).setdefault(signature, []).append((object_id, properties))
    for material_id, variants in groups.items():
        material = by_id[material_id]
        original_signature = tuple(material["properties"][key] for key in _PROPERTY_KEYS)
        primary = original_signature if original_signature in variants else min(
            variants, key=lambda signature: min(item[0] for item in variants[signature])
        )
        original = copy.deepcopy(material)
        for signature, objects in variants.items():
            if signature == primary:
                material["properties"] = objects[0][1]
                continue
            fork = copy.deepcopy(original)
            fork["id"] = _fork_id(material_id, min(item[0] for item in objects), by_id)
            fork["properties"] = objects[0][1]
            materials.append(fork)
            by_id[fork["id"]] = fork
            for object_id, _properties_value in objects:
                assignments[object_id] = fork["id"]
    result = {"version": MATERIAL_ASSETS_VERSION, "materials": materials, "assignments": assignments,
              "object_ids": object_ids}
    if inactive:
        result["inactive_dmi"] = inactive
    if active_without_coefficient:
        result["active_dmi_without_coefficient"] = active_without_coefficient
    return result


def _fork_id(material_id: str, object_id: str, occupied: Mapping[str, Any]) -> str:
    digest = hashlib.sha256((material_id + "\0" + object_id).encode("utf-8")).hexdigest()[:24]
    candidate = f"mat:script:{digest}"
    suffix = 1
    while candidate in occupied:
        candidate = f"mat:script:{digest}:{suffix}"
        suffix += 1
    return candidate
