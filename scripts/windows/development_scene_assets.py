"""Typed SceneDocument asset discovery and capsule-path rebasing.

Only source fields declared by the current authoring scene contract are treated
as files. Opaque payloads are preserved and never searched for path-like keys.
"""

from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass
from typing import Any, Iterable


class SceneAssetError(ValueError):
    """The scene's file references cannot be inventoried completely and safely."""


MAX_SCENE_DEPTH = 128
MAX_SCENE_NODES = 100_000
MAX_SCENE_STRING_CHARS = 16 * 1024 * 1024
MAX_SCENE_ASSETS = 512
MAX_ASSET_ID_CHARS = 256
MAX_SOURCE_PATH_CHARS = 32_768
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SCENE_FIELDS = frozenset({
    "version", "revision", "scene", "universe", "objects", "couplings", "materials",
    "magnetization_assets", "field_drives", "monitors", "selections",
    "magnetization_constraints", "current_modules", "current_transports",
    "spin_transports", "spin_torques", "oersted_fields", "study", "outputs", "editor",
})


@dataclass(frozen=True)
class _AssetReference:
    asset_id: str
    source_path: str
    pointer_parts: tuple[str | int, ...]


# SceneGeometry.geometry_kind uses PascalCase. Nested Scene geometry feature
# nodes also accept serde-tagged snake_case `kind` values.
_SCENE_GEOMETRY_KINDS = {
    "ImportedGeometry": "imported_geometry",
    "Box": "box",
    "Cylinder": "cylinder",
    "SinWaveguide": "sin_waveguide",
    "ArchWaveguide": "arch_waveguide",
    "Ellipsoid": "ellipsoid",
    "Sphere": "sphere",
    "Ellipse": "ellipse",
    "Difference": "difference",
    "Union": "union",
    "Intersection": "intersection",
    "Translate": "translate",
    "Csg": "csg",
    # Current primitive capability names without imported-file semantics.
    "Disk": "disk",
    "Thin Film": "thin_film",
    "ThinFilm": "thin_film",
    "Pillar": "pillar",
    "Nanowire": "nanowire",
    "Ring": "ring",
    "Triangular Prism": "triangular_prism",
    "TriangularPrism": "triangular_prism",
    "Cone": "cone",
    "Capsule": "capsule",
    "Tube": "tube",
    "Wedge": "wedge",
    "Polygon Prism": "polygon_prism",
    "PolygonPrism": "polygon_prism",
}
_SCENE_GEOMETRY_KINDS_BY_TAG = {value: value for value in _SCENE_GEOMETRY_KINDS.values()}
_SCENE_GEOMETRY_KINDS_BY_TAG.update(
    {key.lower(): value for key, value in _SCENE_GEOMETRY_KINDS.items()}
)

_GEOMETRY_IR_TAGS = {
    "imported_geometry",
    "box",
    "cylinder",
    "sin_waveguide",
    "arch_waveguide",
    "ellipsoid",
    "sphere",
    "ellipse",
    "difference",
    "union",
    "intersection",
    "translate",
}

_MAGNETIZATION_KINDS = {
    "uniform",
    "random",
    "random_seeded",
    "file",
    "sampled",
    "preset_texture",
}

# This is the complete current texture preset catalog, including the legacy
# random_seeded id. Unknown preset ids stay opaque in the authoring adapter, so
# handoff must fail closed instead of guessing whether one embeds files.
_PRESET_KINDS = {
    "uniform",
    "random",
    "random_seeded",
    "vortex",
    "antivortex",
    "bloch_skyrmion",
    "neel_skyrmion",
    "antiskyrmion",
    "skyrmionium",
    "bimeron",
    "domain_wall",
    "two_domain",
    "vortex_wall",
    "helical",
    "conical",
    "hopfion",
    "hopfion_compact_support",
}

# These tags are the current serde enums in fullmag-authoring::builder.
# Keep this inventory explicit so a new file-bearing stage or pipeline node
# cannot silently pass through a complete handoff.
_STUDY_PRIMITIVE_STAGE_KINDS = frozenset({
    "relax",
    "run",
    "eigenmodes",
    "frequency_response",
    "hysteresis",
    "change_device",
    "add_field_drive",
    "remove_field_drive",
    "table_autosave",
    "autosave",
    "fft_response",
    "set_field",
    "set_current",
    "save_state",
    "load_state",
    "export",
})
_LEGACY_STUDY_STAGE_KINDS = _STUDY_PRIMITIVE_STAGE_KINDS | {
    # Current builder export action tags that are legacy rows, not pipeline enums.
    "set_transport_current",
    "set_spin_torque_enabled",
}
_STUDY_MACRO_STAGE_KINDS = frozenset({
    "hysteresis_loop",
    "field_sweep_relax",
    "field_sweep_relax_snapshot",
    "relax_run",
    "relax_eigenmodes",
    "parameter_sweep",
})
_STUDY_PIPELINE_VERSION = "study_pipeline.v1"
_EQUILIBRIUM_ARTIFACT_FIELDS = {
    "eigenmodes": ("equilibrium_artifact", "eigen_equilibrium_artifact"),
    "frequency_response": ("equilibrium_artifact", "frequency_equilibrium_artifact"),
}
_EQUILIBRIUM_SOURCE_FIELDS = {
    "eigenmodes": ("equilibrium_source", "eigen_equilibrium_source"),
    "frequency_response": ("equilibrium_source", "frequency_equilibrium_source"),
}
_FLAT_ENTRYPOINT_STAGE_KINDS = {
    "flat_relax": "relax",
    "flat_run": "run",
    "flat_eigenmodes": "eigenmodes",
    "flat_frequency_response": "frequency_response",
    "flat_hysteresis": "hysteresis",
    "flat_save_state": "save_state",
    "flat_load_state": "load_state",
    "flat_export": "export",
}
_EQUILIBRIUM_PAYLOAD_FIELDS = frozenset({
    "adaptive_timestep", "algorithm", "demag_interval_s", "energy_tolerance", "entrypoint_kind",
    "equilibrium", "equilibrium_artifact", "equilibrium_source", "fixed_timestep",
    "frequency_damping_policy", "frequency_equilibrium_artifact", "frequency_equilibrium_source",
    "frequency_include_demag", "frequency_k_vector", "frequency_magnetostatic_bc",
    "frequency_normalization", "frequency_spin_wave_bc", "frequency_spin_wave_bc_config",
    "frequency_solver_method", "frequency_solver_preconditioner", "frequency_solver_rtol",
    "frequency_solver_max_iterations", "frequency_solver_restart_iterations", "frequency_values_hz",
    "frequency_excitation_field_au_per_m", "frequency_excitation_phase_rad", "frequency_observable",
    "integrator", "kind", "max_steps", "output_every_seconds", "relax_algorithm",
    "stage_id", "table_autosave", "autosave", "torque_tolerance", "until_seconds",
    "eigen_count", "eigen_damping_policy", "eigen_equilibrium_artifact", "eigen_equilibrium_source",
    "eigen_frequency_max", "eigen_frequency_min", "eigen_include_demag", "eigen_k_path",
    "eigen_k_sampling", "eigen_k_vector", "eigen_magnetostatic_bc", "eigen_normalization",
    "eigen_operator", "eigen_spin_wave_bc", "eigen_spin_wave_bc_config", "eigen_target",
    "eigen_target_frequency", "frequency_min", "frequency_max",
})
_LOAD_STATE_PAYLOAD_FIELDS = frozenset({
    "action", "artifact_name", "dataset", "entrypoint_kind", "format", "kind",
    "sample_index", "stage_id", "state_path", "output_every_seconds",
})
_MACRO_RELAX_FIELDS = frozenset({
    "adaptive_timestep",
    "demag_interval_s",
    "relax_algorithm",
    "torque_tolerance",
    "torque_tolerance_apm",
    "energy_tolerance",
    "energy_tolerance_j",
    "max_steps",
    "max_relaxation_time_s",
    "max_pseudotime_s",
    "max_physical_time_s",
    "integrator",
    "fixed_timestep",
    "relax_alpha",
})
_MACRO_COMMON_FIELDS = _MACRO_RELAX_FIELDS | {
    "autosave",
    "table_autosave",
    "until_seconds",
}
_MACRO_CONFIG_FIELDS = {
    "relax_run": _MACRO_COMMON_FIELDS | {"run_until_seconds"},
    "relax_eigenmodes": _MACRO_COMMON_FIELDS | {
        "eigen_count",
        "eigen_damping_policy",
        "eigen_equilibrium_artifact",
        "eigen_equilibrium_source",
        "eigen_k_path",
        "eigen_k_sampling",
        "eigen_k_vector",
        "eigen_magnetostatic_bc",
        "eigen_normalization",
        "eigen_operator",
        "eigen_spin_wave_bc",
        "eigen_spin_wave_bc_config",
        "eigen_target",
        "eigen_target_frequency",
        "eigen_frequency_max",
        "eigen_frequency_min",
        "eigen_include_demag",
        "frequency_max",
        "frequency_min",
    },
    "field_sweep_relax": _MACRO_COMMON_FIELDS | {
        "axis",
        "relax_each",
        "run_until_seconds",
        "save_dataset",
        "save_format",
        "save_point_state",
        "settle_until_seconds",
        "start_mT",
        "steps",
        "stop_mT",
        "table_autosave",
    },
    "field_sweep_relax_snapshot": _MACRO_COMMON_FIELDS | {
        "axis",
        "relax_each",
        "run_until_seconds",
        "save_dataset",
        "save_format",
        "save_point_state",
        "settle_until_seconds",
        "start_mT",
        "steps",
        "stop_mT",
        "table_autosave",
    },
    "hysteresis_loop": _MACRO_COMMON_FIELDS | {
        "axis",
        "direction",
        "field_values_t",
        "quantity",
        "save_dataset",
        "save_format",
        "save_state",
        "save_point_state",
        "settle",
        "settle_until_seconds",
        "start_mT",
        "steps",
        "stop_mT",
    },
    "parameter_sweep": _MACRO_COMMON_FIELDS | {
        "axis",
        "parameter",
        "quantity",
        "run_until_seconds",
        "save_dataset",
        "save_format",
        "save_point_state",
        "settle_until_seconds",
        "solve_kind",
        "start",
        "start_mT",
        "start_value",
        "steps",
        "stop",
        "stop_mT",
        "stop_value",
    },
}
_MACRO_SETTLE_FIELDS = frozenset({
    "torque_tolerance_apm",
    "torque_tolerance",
    "energy_tolerance_j",
    "energy_tolerance",
    "max_steps",
    "max_relaxation_time_s",
    "max_pseudotime_s",
    "max_physical_time_s",
})


def _pointer(parts: Iterable[str | int]) -> str:
    def escape(segment: str | int) -> str:
        return str(segment).replace("~", "~0").replace("/", "~1")

    return "".join(f"/{escape(part)}" for part in parts)


def _check_json_tree(scene: Any) -> None:
    """Bound work on caller-provided JSON and reject non-JSON object graphs."""
    nodes = 0
    string_chars = 0
    active_containers: set[int] = set()

    def visit(value: Any, depth: int, at: str) -> None:
        nonlocal nodes, string_chars
        nodes += 1
        if nodes > MAX_SCENE_NODES:
            raise SceneAssetError(f"Scene JSON exceeds the {MAX_SCENE_NODES}-node traversal limit")
        if depth > MAX_SCENE_DEPTH:
            raise SceneAssetError(f"Scene JSON exceeds the depth limit at {at or '/'}")

        if isinstance(value, str):
            string_chars += len(value)
            if string_chars > MAX_SCENE_STRING_CHARS:
                raise SceneAssetError("Scene JSON exceeds the bounded string-data limit")
            return
        if value is None or isinstance(value, (bool, int)):
            return
        if isinstance(value, float):
            if not math.isfinite(value):
                raise SceneAssetError(f"Scene JSON contains a non-finite number at {at or '/'}")
            return
        if isinstance(value, dict):
            identity = id(value)
            if identity in active_containers:
                raise SceneAssetError(f"Scene JSON contains a cyclic object at {at or '/'}")
            active_containers.add(identity)
            try:
                for key, child in value.items():
                    if not isinstance(key, str):
                        raise SceneAssetError(f"Scene JSON object keys must be strings at {at or '/'}")
                    string_chars += len(key)
                    if string_chars > MAX_SCENE_STRING_CHARS:
                        raise SceneAssetError("Scene JSON exceeds the bounded string-data limit")
                    visit(child, depth + 1, _pointer((*_pointer_segments(at), key)))
            finally:
                active_containers.remove(identity)
            return
        if isinstance(value, list):
            identity = id(value)
            if identity in active_containers:
                raise SceneAssetError(f"Scene JSON contains a cyclic array at {at or '/'}")
            active_containers.add(identity)
            try:
                for index, child in enumerate(value):
                    visit(child, depth + 1, _pointer((*_pointer_segments(at), index)))
            finally:
                active_containers.remove(identity)
            return
        raise SceneAssetError(f"Scene contains a non-JSON value at {at or '/'}")

    if not isinstance(scene, dict):
        raise SceneAssetError("scene must be the canonical SceneDocument JSON object")
    visit(scene, 0, "")


def _pointer_segments(pointer: str) -> tuple[str, ...]:
    """Decode a pointer generated above for error locations only."""
    if not pointer:
        return ()
    result = []
    for segment in pointer[1:].split("/"):
        result.append(segment.replace("~1", "/").replace("~0", "~"))
    return tuple(result)


def _object(value: Any, at: str, description: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SceneAssetError(f"{description} must be an object at {at or '/'}")
    return value


def _reject_unknown_fields(
    value: dict[str, Any],
    allowed: Iterable[str],
    parts: tuple[str | int, ...],
    description: str,
) -> None:
    unknown = set(value) - set(allowed)
    if unknown:
        names = ", ".join(sorted(unknown)[:4])
        raise SceneAssetError(
            f"Unsupported {description} fields at {_pointer(parts)}: {names}; asset semantics are unknown"
        )


def _validate_sample_period_policy(value: Any, parts: tuple[str | int, ...]) -> None:
    if value is None:
        return
    policy = _object(value, _pointer(parts), "sample period policy")
    _reject_unknown_fields(policy, {"kind", "nyquist_guard_factor"}, parts, "sample period policy")
    if policy.get("kind") != "auto_sinc_cutoff":
        raise SceneAssetError(f"Unsupported sample period policy kind at {_pointer(parts)}")


def _validate_table_autosave(value: Any, parts: tuple[str | int, ...]) -> None:
    if value is None:
        return
    table = _object(value, _pointer(parts), "table autosave")
    _reject_unknown_fields(
        table,
        {"kind", "table_id", "sample_period_s", "sample_period_policy", "resolved_sample_period_s", "every_steps", "quantities", "expressions"},
        parts,
        "table autosave",
    )
    if "sample_period_policy" in table:
        _validate_sample_period_policy(table["sample_period_policy"], (*parts, "sample_period_policy"))


def _validate_stage_autosave(value: Any, parts: tuple[str | int, ...]) -> None:
    if value is None:
        return
    autosave = _object(value, _pointer(parts), "stage autosave")
    _reject_unknown_fields(autosave, {"kind", "target", "layout", "format", "table", "fields"}, parts, "stage autosave")
    if "table" in autosave:
        _validate_table_autosave(autosave["table"], (*parts, "table"))
    if "fields" in autosave:
        fields = _array(autosave["fields"], _pointer((*parts, "fields")), "stage autosave fields")
        for index, field_value in enumerate(fields):
            field_parts = (*parts, "fields", index)
            field = _object(field_value, _pointer(field_parts), "field autosave")
            _reject_unknown_fields(
                field,
                {"kind", "quantity", "every_seconds", "sample_period_policy", "every_steps"},
                field_parts,
                "field autosave",
            )
            if "sample_period_policy" in field:
                _validate_sample_period_policy(field["sample_period_policy"], (*field_parts, "sample_period_policy"))


def _array(value: Any, at: str, description: str) -> list[Any]:
    if not isinstance(value, list):
        raise SceneAssetError(f"{description} must be an array at {at or '/'}")
    return value


def _required_string(value: Any, at: str, description: str, *, max_chars: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SceneAssetError(f"{description} must be a non-empty string at {at or '/'}")
    if len(value) > max_chars or any(ord(character) < 32 for character in value):
        raise SceneAssetError(f"{description} is malformed or exceeds its bound at {at or '/'}")
    return value


def _optional_path(owner: dict[str, Any], key: str, owner_parts: tuple[str | int, ...], description: str) -> tuple[str, tuple[str | int, ...]] | None:
    if key not in owner or owner[key] is None:
        return None
    path_parts = (*owner_parts, key)
    return (
        _required_string(owner[key], _pointer(path_parts), description, max_chars=MAX_SOURCE_PATH_CHARS),
        path_parts,
    )


def _add_reference(
    references: list[_AssetReference],
    source_path: str,
    pointer_parts: tuple[str | int, ...],
) -> None:
    asset_id = _pointer(pointer_parts)
    if len(asset_id) > MAX_ASSET_ID_CHARS:
        raise SceneAssetError(f"Scene asset reference id exceeds {MAX_ASSET_ID_CHARS} characters: {asset_id[:80]}")
    if len(references) >= MAX_SCENE_ASSETS:
        raise SceneAssetError(f"Scene contains more than {MAX_SCENE_ASSETS} declared file references")
    references.append(_AssetReference(asset_id, source_path, pointer_parts))


def _geometry_kind(node: dict[str, Any], at: str) -> str:
    has_geometry_kind = "geometry_kind" in node
    has_kind = "kind" in node
    if has_geometry_kind and has_kind and node["geometry_kind"] != node["kind"]:
        raise SceneAssetError(f"Conflicting geometry_kind and kind at {at or '/'}")
    raw_kind = node.get("geometry_kind") if has_geometry_kind else node.get("kind")
    if not isinstance(raw_kind, str) or not raw_kind:
        raise SceneAssetError(f"Geometry kind must be a non-empty string at {at or '/'}")
    if has_geometry_kind:
        normalized = _SCENE_GEOMETRY_KINDS.get(raw_kind)
        if normalized is None:
            normalized = _SCENE_GEOMETRY_KINDS_BY_TAG.get(raw_kind)
    else:
        normalized = _SCENE_GEOMETRY_KINDS_BY_TAG.get(raw_kind)
    if normalized is None:
        raise SceneAssetError(f"Unsupported geometry kind '{raw_kind}' at {at or '/'}; asset semantics are unknown")
    return normalized


def _geometry_params(node: dict[str, Any], node_parts: tuple[str | int, ...]) -> tuple[dict[str, Any], tuple[str | int, ...]]:
    if "geometry_params" in node:
        params = node["geometry_params"]
        params_parts = (*node_parts, "geometry_params")
        if params is None:
            return {}, params_parts
        return _object(params, _pointer(params_parts), "geometry_params"), params_parts
    # Geometry feature nodes also accept the serde-tagged/flat representation.
    return node, node_parts


def _walk_scene_geometry(
    node_value: Any,
    node_parts: tuple[str | int, ...],
    references: list[_AssetReference],
    depth: int,
) -> None:
    if depth > MAX_SCENE_DEPTH:
        raise SceneAssetError(f"Geometry nesting exceeds the depth limit at {_pointer(node_parts) or '/'}")
    node = _object(node_value, _pointer(node_parts), "geometry node")
    kind = _geometry_kind(node, _pointer(node_parts))
    params, params_parts = _geometry_params(node, node_parts)

    if kind == "imported_geometry":
        imported = _optional_path(params, "source", params_parts, "Imported geometry source")
        if imported is None:
            raise SceneAssetError(f"Imported geometry has no source at {_pointer(node_parts) or '/'}")
        _add_reference(references, imported[0], imported[1])
        return

    if kind in {"difference", "union", "intersection", "translate"}:
        if kind == "difference":
            child_fields = ("base", "tool")
        elif kind in {"union", "intersection"}:
            child_fields = ("a", "b")
        else:
            child_fields = ("base",)
        for field in child_fields:
            if field not in params:
                raise SceneAssetError(f"{kind} geometry is missing '{field}' at {_pointer(params_parts) or '/'}")
            _walk_scene_geometry(params[field], (*params_parts, field), references, depth + 1)
        return

    if kind == "csg":
        children = params.get("children")
        if not isinstance(children, list) or len(children) < 2:
            raise SceneAssetError(f"CSG geometry requires at least two children at {_pointer(params_parts) or '/'}")
        for index, child in enumerate(children):
            _walk_scene_geometry(child, (*params_parts, "children", index), references, depth + 1)
        return

    # Every other currently declared primitive has no file-bearing fields.


def _walk_geometry_ir(
    node_value: Any,
    node_parts: tuple[str | int, ...],
    references: list[_AssetReference],
    depth: int,
) -> None:
    if depth > MAX_SCENE_DEPTH:
        raise SceneAssetError(f"Region CSG nesting exceeds the depth limit at {_pointer(node_parts) or '/'}")
    node = _object(node_value, _pointer(node_parts), "region CSG geometry expression")
    kind = node.get("kind")
    if not isinstance(kind, str) or not kind or kind not in _GEOMETRY_IR_TAGS:
        raise SceneAssetError(f"Unsupported region CSG geometry kind '{kind}' at {_pointer(node_parts) or '/'}")

    if kind == "imported_geometry":
        imported = _optional_path(node, "source", node_parts, "Imported region geometry source")
        if imported is None:
            raise SceneAssetError(f"Imported region geometry has no source at {_pointer(node_parts) or '/'}")
        _add_reference(references, imported[0], imported[1])
        _required_string(node.get("format"), _pointer((*node_parts, "format")), "Imported geometry format", max_chars=64)
        return

    if kind in {"difference"}:
        child_fields = ("base", "tool")
    elif kind in {"union", "intersection"}:
        child_fields = ("a", "b")
    elif kind == "translate":
        child_fields = ("base",)
    else:
        child_fields = ()
    for field in child_fields:
        if field not in node:
            raise SceneAssetError(f"Region CSG {kind} expression is missing '{field}' at {_pointer(node_parts) or '/'}")
        _walk_geometry_ir(node[field], (*node_parts, field), references, depth + 1)


def _walk_region_shape(
    shape_value: Any,
    shape_parts: tuple[str | int, ...],
    references: list[_AssetReference],
) -> None:
    shape = _object(shape_value, _pointer(shape_parts), "region shape")
    kind = shape.get("kind")
    if not isinstance(kind, str) or not kind:
        raise SceneAssetError(f"Region shape kind must be a non-empty string at {_pointer(shape_parts) or '/'}")
    if kind in {"box", "cylinder", "sphere"}:
        return
    if kind != "csg":
        raise SceneAssetError(f"Unsupported region shape kind '{kind}' at {_pointer(shape_parts) or '/'}")
    if "expression" not in shape:
        raise SceneAssetError(f"Region CSG shape is missing expression at {_pointer(shape_parts) or '/'}")
    _walk_geometry_ir(shape["expression"], (*shape_parts, "expression"), references, 0)


def _check_region_texture_override(value: Any, parts: tuple[str | int, ...]) -> None:
    override = _object(value, _pointer(parts), "region texture_override")
    if "initial_magnetization" not in override:
        raise SceneAssetError(f"Region texture_override is missing initial_magnetization at {_pointer(parts)}")
    initial_parts = (*parts, "initial_magnetization")
    initial = _object(override["initial_magnetization"], _pointer(initial_parts), "initial magnetization")
    kind = initial.get("kind")
    if not isinstance(kind, str) or not kind:
        raise SceneAssetError(f"Initial magnetization kind must be a non-empty string at {_pointer(initial_parts)}")
    if kind in {"uniform", "random_seeded", "sampled_field"}:
        return
    if kind != "preset_texture":
        raise SceneAssetError(f"Unsupported initial magnetization kind '{kind}' at {_pointer(initial_parts)}")
    preset_kind = initial.get("preset_kind")
    if not isinstance(preset_kind, str) or preset_kind not in _PRESET_KINDS:
        raise SceneAssetError(
            f"Unsupported region texture preset '{preset_kind}' at {_pointer((*initial_parts, 'preset_kind'))}; asset semantics are unknown"
        )


def _validate_magnetization_registry(scene: dict[str, Any], references: list[_AssetReference]) -> set[str]:
    assets_value = scene.get("magnetization_assets", [])
    assets = _array(assets_value, "/magnetization_assets", "magnetization_assets")
    ids: set[str] = set()
    for index, asset_value in enumerate(assets):
        parts: tuple[str | int, ...] = ("magnetization_assets", index)
        asset = _object(asset_value, _pointer(parts), "magnetization asset")
        asset_id = _required_string(asset.get("id"), _pointer((*parts, "id")), "Magnetization asset id", max_chars=MAX_ASSET_ID_CHARS)
        if asset_id in ids:
            raise SceneAssetError(f"Duplicate magnetization asset id '{asset_id}'")
        ids.add(asset_id)

        kind = asset.get("kind")
        if not isinstance(kind, str) or kind not in _MAGNETIZATION_KINDS:
            raise SceneAssetError(f"Unsupported magnetization asset kind '{kind}' at {_pointer((*parts, 'kind'))}")
        if kind == "preset_texture":
            preset_kind = asset.get("preset_kind", "uniform")
            if not isinstance(preset_kind, str) or preset_kind not in _PRESET_KINDS:
                raise SceneAssetError(
                    f"Unsupported preset_texture kind '{preset_kind}' at {_pointer((*parts, 'preset_kind'))}; asset semantics are unknown"
                )

        source = _optional_path(asset, "source_path", parts, "Magnetization asset source")
        if kind in {"file", "sampled"} and source is None:
            raise SceneAssetError(f"Sampled magnetization asset has no source_path at {_pointer(parts)}")
        if source is not None:
            _add_reference(references, source[0], source[1])
    return ids


def _check_magnetization_ref(value: Any, at: str, asset_ids: set[str]) -> None:
    if value is None:
        return
    reference = _required_string(value, at, "Magnetization reference", max_chars=MAX_ASSET_ID_CHARS)
    if reference not in asset_ids:
        raise SceneAssetError(f"Magnetization reference '{reference}' does not resolve to magnetization_assets at {at}")


def _check_material_parameter_field(value: Any, parts: tuple[str | int, ...]) -> None:
    field = _object(value, _pointer(parts), "material parameter field")
    kind = field.get("kind")
    if not isinstance(kind, str) or not kind:
        raise SceneAssetError(f"Material parameter field kind must be a non-empty string at {_pointer(parts)}")
    if kind in {"constant", "linear", "radial"}:
        return
    if kind == "sampled":
        asset_id = _required_string(
            field.get("asset_id"),
            _pointer((*parts, "asset_id")),
            "Sampled material field asset_id",
            max_chars=MAX_ASSET_ID_CHARS,
        )
        raise SceneAssetError(
            f"Sampled material field asset '{asset_id}' at {_pointer(parts)} has no file-backed registry in SceneDocument; asset semantics are unsupported"
        )
    raise SceneAssetError(f"Unsupported material parameter field kind '{kind}' at {_pointer(parts)}")


def _walk_geometry_predicate(value: Any, parts: tuple[str | int, ...], depth: int) -> None:
    if depth > MAX_SCENE_DEPTH:
        raise SceneAssetError(f"Selection geometry nesting exceeds the depth limit at {_pointer(parts) or '/'}")
    node = _object(value, _pointer(parts), "selection geometry predicate")
    kind = node.get("kind")
    if not isinstance(kind, str) or not kind:
        raise SceneAssetError(f"Selection geometry predicate kind must be a non-empty string at {_pointer(parts)}")
    if kind == "imported_solid":
        asset_id = _required_string(
            node.get("asset_id"),
            _pointer((*parts, "asset_id")),
            "ImportedSolid asset_id",
            max_chars=MAX_ASSET_ID_CHARS,
        )
        raise SceneAssetError(
            f"ImportedSolid asset '{asset_id}' at {_pointer(parts)} has no file-backed registry in SceneDocument; asset semantics are unsupported"
        )
    if kind in {"box", "cylinder", "sphere", "ellipsoid"}:
        return
    children_by_kind = {
        "union": ("a", "b"),
        "intersection": ("a", "b"),
        "xor": ("a", "b"),
        "difference": ("base", "tool"),
        "complement": ("geometry", "domain"),
        "affine": ("geometry",),
    }
    children = children_by_kind.get(kind)
    if children is None:
        raise SceneAssetError(f"Unsupported selection geometry predicate kind '{kind}' at {_pointer(parts)}")
    for field in children:
        if field not in node:
            raise SceneAssetError(f"Selection geometry predicate {kind} is missing '{field}' at {_pointer(parts)}")
        _walk_geometry_predicate(node[field], (*parts, field), depth + 1)


def _walk_selection_expression(value: Any, parts: tuple[str | int, ...], depth: int = 0) -> None:
    if depth > MAX_SCENE_DEPTH:
        raise SceneAssetError(f"Selection expression nesting exceeds the depth limit at {_pointer(parts) or '/'}")
    expression = _object(value, _pointer(parts), "selection expression")
    kind = expression.get("kind")
    if not isinstance(kind, str) or not kind:
        raise SceneAssetError(f"Selection expression kind must be a non-empty string at {_pointer(parts)}")
    if kind in {"all_magnetic", "in_object", "in_region", "ref"}:
        return
    if kind == "inside_geometry":
        if "geometry" not in expression:
            raise SceneAssetError(f"inside_geometry expression is missing geometry at {_pointer(parts)}")
        _walk_geometry_predicate(expression["geometry"], (*parts, "geometry"), depth + 1)
        return
    if kind in {"and", "or", "xor"}:
        expressions = _array(expression.get("expressions"), _pointer((*parts, "expressions")), "selection expressions")
        for index, child in enumerate(expressions):
            _walk_selection_expression(child, (*parts, "expressions", index), depth + 1)
        return
    if kind == "not":
        if "expression" not in expression:
            raise SceneAssetError(f"not expression is missing expression at {_pointer(parts)}")
        _walk_selection_expression(expression["expression"], (*parts, "expression"), depth + 1)
        return
    if kind in {"compare", "approx", "between"}:
        # These expressions contain scalar math only; they have no asset-bearing fields.
        return
    raise SceneAssetError(f"Unsupported selection expression kind '{kind}' at {_pointer(parts)}")


def _walk_equilibrium_artifact(
    value: Any,
    parts: tuple[str | int, ...],
    references: list[_AssetReference],
) -> bool:
    equilibrium = _object(value, _pointer(parts), "study equilibrium")
    unknown_fields = set(equilibrium) - {"kind", "path"}
    if unknown_fields:
        raise SceneAssetError(
            f"Unsupported study equilibrium fields at {_pointer(parts)}: "
            f"{', '.join(sorted(unknown_fields)[:4])}"
        )
    kind = equilibrium.get("kind")
    if kind == "artifact":
        source = _optional_path(equilibrium, "path", parts, "study equilibrium artifact path")
        if source is None:
            raise SceneAssetError(f"Artifact equilibrium is missing path at {_pointer(parts)}")
        _add_reference(references, source[0], source[1])
        return True
    if kind not in {"provided", "relaxed_initial_state"}:
        raise SceneAssetError(f"Unsupported study equilibrium kind '{kind}' at {_pointer(parts)}")
    if equilibrium.get("path") is not None:
        raise SceneAssetError(
            f"Non-artifact study equilibrium has a file path at {_pointer(parts)}"
        )
    return False


def _walk_equilibrium_stage_fields(
    stage_kind: str,
    payload: dict[str, Any],
    payload_parts: tuple[str | int, ...],
    references: list[_AssetReference],
) -> None:
    path_fields = _EQUILIBRIUM_ARTIFACT_FIELDS[stage_kind]
    source_fields = _EQUILIBRIUM_SOURCE_FIELDS[stage_kind]
    has_artifact_path = False
    artifact_values: list[str] = []
    source_kinds: list[str] = []

    for field in path_fields:
        # Both SceneDocument and the Python authoring adapter can emit the
        # generic and stage-prefixed alias. Empty text is absent in those
        # adapters; non-empty aliases must agree before a restore can choose.
        if payload.get(field) in (None, ""):
            continue
        source = _optional_path(payload, field, payload_parts, f"{stage_kind} {field}")
        if source is not None:
            _add_reference(references, source[0], source[1])
            artifact_values.append(source[0])
            has_artifact_path = True

    for field in source_fields:
        raw_source = payload.get(field)
        if raw_source is None or raw_source == "":
            continue
        source_kind = _required_string(
            raw_source,
            _pointer((*payload_parts, field)),
            f"{stage_kind} equilibrium source",
            max_chars=64,
        )
        if source_kind not in {"artifact", "provided", "relax"}:
            raise SceneAssetError(
                f"Unsupported {stage_kind} equilibrium source '{source_kind}' "
                f"at {_pointer((*payload_parts, field))}"
            )
        source_kinds.append(source_kind)
    if len(set(source_kinds)) > 1:
        raise SceneAssetError(
            f"Conflicting {stage_kind} equilibrium source fields at {_pointer(payload_parts)}"
        )

    if len(set(artifact_values)) > 1:
        raise SceneAssetError(
            f"Conflicting {stage_kind} equilibrium artifact aliases at {_pointer(payload_parts)}"
        )

    if "equilibrium" in payload and payload["equilibrium"] is not None:
        has_artifact_path = _walk_equilibrium_artifact(
            payload["equilibrium"],
            (*payload_parts, "equilibrium"),
            references,
        ) or has_artifact_path
    if source_kinds and source_kinds[0] == "artifact" and not has_artifact_path:
        raise SceneAssetError(
            f"{stage_kind} equilibrium_source='artifact' is missing equilibrium_artifact "
            f"at {_pointer(payload_parts)}"
        )


def _walk_load_state_fields(
    payload: dict[str, Any],
    payload_parts: tuple[str | int, ...],
    references: list[_AssetReference],
) -> None:
    action = payload.get("action")
    if action is not None:
        action_parts = (*payload_parts, "action")
        action_obj = _object(action, _pointer(action_parts), "load_state action")
        _reject_unknown_fields(action_obj, _LOAD_STATE_PAYLOAD_FIELDS - {"action", "entrypoint_kind", "stage_id", "output_every_seconds"}, action_parts, "load_state action")
        if action_obj.get("kind") != "load_state":
            raise SceneAssetError(
                f"load_state stage has an unsupported action kind at {_pointer(action_parts)}"
            )
        payload = action_obj
        payload_parts = action_parts
    elif payload.get("kind") not in {None, "load_state"}:
        raise SceneAssetError(
            f"load_state stage payload has conflicting kind at {_pointer(payload_parts)}"
        )

    artifact_name = payload.get("artifact_name")
    if artifact_name is not None:
        _required_string(
            artifact_name,
            _pointer((*payload_parts, "artifact_name")),
            "load_state artifact_name",
            max_chars=MAX_ASSET_ID_CHARS,
        )
    state_path = _optional_path(payload, "state_path", payload_parts, "load_state state_path")
    if (artifact_name is None) == (state_path is None):
        raise SceneAssetError(
            "load_state requires exactly one of artifact_name or state_path "
            f"at {_pointer(payload_parts)}"
        )
    if state_path is not None:
        _add_reference(references, state_path[0], state_path[1])


def _walk_study_stage_payload(
    stage_kind: str,
    payload: dict[str, Any],
    payload_parts: tuple[str | int, ...],
    references: list[_AssetReference],
) -> None:
    if stage_kind in _EQUILIBRIUM_ARTIFACT_FIELDS:
        _reject_unknown_fields(payload, _EQUILIBRIUM_PAYLOAD_FIELDS, payload_parts, f"{stage_kind} payload")
        for field in ("table_autosave",):
            if field in payload:
                _validate_table_autosave(payload[field], (*payload_parts, field))
        if "autosave" in payload:
            _validate_stage_autosave(payload["autosave"], (*payload_parts, "autosave"))
        _walk_equilibrium_stage_fields(stage_kind, payload, payload_parts, references)
    elif stage_kind == "load_state":
        _reject_unknown_fields(payload, _LOAD_STATE_PAYLOAD_FIELDS, payload_parts, "load_state payload")
        _walk_load_state_fields(payload, payload_parts, references)


def _study_stage_kind(
    value: Any,
    parts: tuple[str | int, ...],
    field: str,
    *,
    legacy: bool = False,
) -> str:
    stage_kind = value.get("stage_kind") or value.get("kind")
    if stage_kind is None:
        entrypoint = value.get("entrypoint_kind")
        stage_kind = _FLAT_ENTRYPOINT_STAGE_KINDS.get(entrypoint)
    supported_kinds = _LEGACY_STUDY_STAGE_KINDS if legacy else _STUDY_PRIMITIVE_STAGE_KINDS
    if not isinstance(stage_kind, str) or stage_kind not in supported_kinds:
        raise SceneAssetError(
            f"Unsupported study {field} kind '{stage_kind}' at {_pointer(parts)}; "
            "asset semantics are unknown"
        )
    return stage_kind


def _walk_legacy_study_stages(
    value: Any,
    parts: tuple[str | int, ...],
    references: list[_AssetReference],
) -> None:
    stages = _array(value, _pointer(parts), "study.stages")
    for index, stage_value in enumerate(stages):
        stage_parts = (*parts, index)
        stage = _object(stage_value, _pointer(stage_parts), "study stage")
        stage_kind = _study_stage_kind(stage, stage_parts, "stage", legacy=True)
        payload_value = stage.get("payload", stage)
        payload_parts = (*stage_parts, "payload") if "payload" in stage else stage_parts
        payload = _object(payload_value, _pointer(payload_parts), "study stage payload")
        _walk_study_stage_payload(stage_kind, payload, payload_parts, references)


def _walk_study_pipeline_node(
    value: Any,
    parts: tuple[str | int, ...],
    references: list[_AssetReference],
    depth: int,
) -> None:
    if depth > MAX_SCENE_DEPTH:
        raise SceneAssetError(f"Study pipeline nesting exceeds the depth limit at {_pointer(parts)}")
    node = _object(value, _pointer(parts), "study pipeline node")
    node_kind = node.get("node_kind")
    if node_kind == "primitive":
        _reject_unknown_fields(
            node,
            {"node_kind", "id", "label", "enabled", "notes", "source", "stage_kind", "payload"},
            parts,
            "study pipeline primitive",
        )
        stage_kind = node.get("stage_kind")
        if not isinstance(stage_kind, str) or stage_kind not in _STUDY_PRIMITIVE_STAGE_KINDS:
            raise SceneAssetError(
                f"Unsupported study pipeline stage_kind '{stage_kind}' at {_pointer(parts)}; "
                "asset semantics are unknown"
            )
        payload_parts = (*parts, "payload")
        payload = _object(node.get("payload", {}), _pointer(payload_parts), "study stage payload")
        _walk_study_stage_payload(stage_kind, payload, payload_parts, references)
        return

    if node_kind == "macro":
        _reject_unknown_fields(
            node,
            {"node_kind", "id", "label", "enabled", "notes", "source", "macro_kind", "config"},
            parts,
            "study pipeline macro",
        )
        macro_kind = node.get("macro_kind")
        if not isinstance(macro_kind, str) or macro_kind not in _STUDY_MACRO_STAGE_KINDS:
            raise SceneAssetError(
                f"Unsupported study pipeline macro_kind '{macro_kind}' at {_pointer(parts)}; "
                "asset semantics are unknown"
            )
        config_parts = (*parts, "config")
        config = _object(node.get("config", {}), _pointer(config_parts), "study macro config")
        _reject_unknown_fields(config, _MACRO_CONFIG_FIELDS[macro_kind], config_parts, f"{macro_kind} macro config")
        if "settle" in config:
            settle_parts = (*config_parts, "settle")
            settle = _object(config["settle"], _pointer(settle_parts), "hysteresis settle config")
            _reject_unknown_fields(settle, _MACRO_SETTLE_FIELDS, settle_parts, "hysteresis settle config")
        if "table_autosave" in config:
            _validate_table_autosave(config["table_autosave"], (*config_parts, "table_autosave"))
        if "autosave" in config:
            _validate_stage_autosave(config["autosave"], (*config_parts, "autosave"))

        # Only relax_eigenmodes materializes an eigenmodes payload, whose CLI
        # consumer reads the stage-prefixed source and artifact names.
        artifact_fields = ("eigen_equilibrium_artifact",) if macro_kind == "relax_eigenmodes" else ()
        source_fields = ("eigen_equilibrium_source",) if macro_kind == "relax_eigenmodes" else ()
        for field in artifact_fields:
            source = _optional_path(config, field, config_parts, f"study macro {field}")
            if source is not None:
                _add_reference(references, source[0], source[1])
        source_values = [config[field] for field in source_fields if config.get(field) not in (None, "")]
        if any(not isinstance(source, str) or source not in {"artifact", "provided", "relax"} for source in source_values):
            raise SceneAssetError(f"Unsupported study macro equilibrium source at {_pointer(config_parts)}")
        if source_values == ["artifact"] and not any(config.get(field) for field in artifact_fields):
            raise SceneAssetError(
                f"Study macro eigen_equilibrium_source='artifact' is missing eigen_equilibrium_artifact "
                f"at {_pointer(config_parts)}"
            )
        return

    if node_kind == "group":
        _reject_unknown_fields(
            node,
            {"node_kind", "id", "label", "enabled", "notes", "source", "collapsed", "children"},
            parts,
            "study pipeline group",
        )
        children_parts = (*parts, "children")
        children = _array(node.get("children", []), _pointer(children_parts), "study group children")
        for index, child in enumerate(children):
            _walk_study_pipeline_node(child, (*children_parts, index), references, depth + 1)
        return

    raise SceneAssetError(
        f"Unsupported study pipeline node_kind '{node_kind}' at {_pointer(parts)}; "
        "asset semantics are unknown"
    )


def _walk_study_assets(
    study: dict[str, Any],
    references: list[_AssetReference],
) -> None:
    if "stages" in study and study["stages"] is not None:
        _walk_legacy_study_stages(study["stages"], ("study", "stages"), references)

    pipeline_value = study.get("study_pipeline")
    if pipeline_value is None:
        return
    pipeline = _object(pipeline_value, "/study/study_pipeline", "study.study_pipeline")
    version = pipeline.get("version", _STUDY_PIPELINE_VERSION)
    if version != _STUDY_PIPELINE_VERSION:
        raise SceneAssetError(
            f"Unsupported study pipeline version '{version}'; asset semantics are unknown"
        )
    nodes_parts: tuple[str | int, ...] = ("study", "study_pipeline", "nodes")
    nodes = _array(pipeline.get("nodes", []), _pointer(nodes_parts), "study pipeline nodes")
    for index, node in enumerate(nodes):
        _walk_study_pipeline_node(node, (*nodes_parts, index), references, 0)


def _collect_references(scene: dict[str, Any]) -> list[_AssetReference]:
    _check_json_tree(scene)
    if scene.get("version", "scene.v2") != "scene.v2":
        raise SceneAssetError("Unsupported scene version; file reference semantics are unknown")
    unknown = set(scene) - _SCENE_FIELDS
    if unknown:
        raise SceneAssetError(f"Unsupported scene fields: {', '.join(sorted(unknown)[:4])}; asset ownership is unknown")
    references: list[_AssetReference] = []
    asset_ids = _validate_magnetization_registry(scene, references)

    objects = _array(scene.get("objects", []), "/objects", "objects")
    for object_index, object_value in enumerate(objects):
        object_parts: tuple[str | int, ...] = ("objects", object_index)
        obj = _object(object_value, _pointer(object_parts), "scene object")
        geometry_parts = (*object_parts, "geometry")
        if "geometry" not in obj:
            raise SceneAssetError(f"Scene object is missing geometry at {_pointer(object_parts)}")
        _walk_scene_geometry(obj["geometry"], geometry_parts, references, 0)

        for mesh_field in ("object_mesh", "mesh_override"):
            mesh_value = obj.get(mesh_field)
            if mesh_value is None:
                continue
            mesh_parts = (*object_parts, mesh_field)
            mesh = _object(mesh_value, _pointer(mesh_parts), mesh_field)
            source = _optional_path(mesh, "source", mesh_parts, f"{mesh_field} source")
            if source is not None:
                _add_reference(references, source[0], source[1])

        regions = _array(obj.get("regions", []), _pointer((*object_parts, "regions")), "object regions")
        for region_index, region_value in enumerate(regions):
            region_parts = (*object_parts, "regions", region_index)
            region = _object(region_value, _pointer(region_parts), "object region")
            if "shape" not in region:
                raise SceneAssetError(f"Object region is missing shape at {_pointer(region_parts)}")
            _walk_region_shape(region["shape"], (*region_parts, "shape"), references)
            texture_override = region.get("texture_override")
            if texture_override is not None:
                _check_region_texture_override(texture_override, (*region_parts, "texture_override"))
            overrides = _array(
                region.get("material_overrides", []),
                _pointer((*region_parts, "material_overrides")),
                "region material_overrides",
            )
            for override_index, override_value in enumerate(overrides):
                override_parts = (*region_parts, "material_overrides", override_index)
                override = _object(override_value, _pointer(override_parts), "region material override")
                if "value" not in override:
                    raise SceneAssetError(f"Region material override is missing value at {_pointer(override_parts)}")
                _check_material_parameter_field(override["value"], (*override_parts, "value"))

        material_fields = _array(
            obj.get("material_parameter_fields", []),
            _pointer((*object_parts, "material_parameter_fields")),
            "object material_parameter_fields",
        )
        for field_index, field_value in enumerate(material_fields):
            field_parts = (*object_parts, "material_parameter_fields", field_index, "value")
            field_assignment = _object(field_value, _pointer((*object_parts, "material_parameter_fields", field_index)), "material parameter assignment")
            if "value" not in field_assignment:
                raise SceneAssetError(f"Material parameter assignment is missing value at {_pointer(field_parts[:-1])}")
            _check_material_parameter_field(field_assignment["value"], field_parts)

        _check_magnetization_ref(obj.get("magnetization_ref"), _pointer((*object_parts, "magnetization_ref")), asset_ids)
        region_overrides = obj.get("region_overrides", {})
        if not isinstance(region_overrides, dict):
            raise SceneAssetError(f"region_overrides must be an object at {_pointer((*object_parts, 'region_overrides'))}")
        for region_id, override_value in region_overrides.items():
            if not isinstance(region_id, str):
                raise SceneAssetError(f"region_overrides keys must be strings at {_pointer((*object_parts, 'region_overrides'))}")
            override = _object(override_value, _pointer((*object_parts, "region_overrides", region_id)), "region override")
            _check_magnetization_ref(
                override.get("magnetization_ref"),
                _pointer((*object_parts, "region_overrides", region_id, "magnetization_ref")),
                asset_ids,
            )

    study_value = scene.get("study", {})
    study = _object(study_value, "/study", "study")
    _walk_study_assets(study, references)
    initial_state = study.get("initial_state")
    if initial_state is not None:
        initial_parts: tuple[str | int, ...] = ("study", "initial_state")
        initial = _object(initial_state, _pointer(initial_parts), "study initial_state")
        if "source_path" not in initial:
            raise SceneAssetError(f"study.initial_state is missing source_path at {_pointer(initial_parts)}")
        source = _optional_path(initial, "source_path", initial_parts, "study.initial_state source_path")
        if source is None:
            raise SceneAssetError("study.initial_state source_path must not be null")
        _add_reference(references, source[0], source[1])

    interfaces = _array(study.get("mesh_interfaces", []), "/study/mesh_interfaces", "study.mesh_interfaces")
    for interface_index, interface_value in enumerate(interfaces):
        interface_parts: tuple[str | int, ...] = ("study", "mesh_interfaces", interface_index)
        interface = _object(interface_value, _pointer(interface_parts), "mesh interface")
        config_value = interface.get("config")
        if config_value is None:
            continue
        config_parts = (*interface_parts, "config")
        config = _object(config_value, _pointer(config_parts), "mesh interface config")
        source = _optional_path(config, "source", config_parts, "mesh interface source")
        if source is not None:
            _add_reference(references, source[0], source[1])

    selections = _array(scene.get("selections", []), "/selections", "selections")
    for index, selection_value in enumerate(selections):
        selection_parts: tuple[str | int, ...] = ("selections", index)
        selection = _object(selection_value, _pointer(selection_parts), "selection definition")
        if "expression" not in selection:
            raise SceneAssetError(f"Selection definition is missing expression at {_pointer(selection_parts)}")
        _walk_selection_expression(selection["expression"], (*selection_parts, "expression"))

    constraints = _array(scene.get("magnetization_constraints", []), "/magnetization_constraints", "magnetization_constraints")
    for index, constraint_value in enumerate(constraints):
        constraint_parts: tuple[str | int, ...] = ("magnetization_constraints", index)
        constraint = _object(constraint_value, _pointer(constraint_parts), "magnetization constraint")
        if constraint.get("kind") != "frozen_spins":
            raise SceneAssetError(f"Unsupported magnetization constraint kind '{constraint.get('kind')}' at {_pointer(constraint_parts)}")
        if "selector" in constraint:
            _walk_selection_expression(constraint["selector"], (*constraint_parts, "selector"))
        reference = constraint.get("reference")
        if reference is not None:
            reference_parts = (*constraint_parts, "reference")
            reference_obj = _object(reference, _pointer(reference_parts), "frozen-spin reference")
            reference_kind = reference_obj.get("kind")
            if reference_kind == "explicit_field_asset":
                asset_id = _required_string(
                    reference_obj.get("asset_id"),
                    _pointer((*reference_parts, "asset_id")),
                    "Explicit field asset_id",
                    max_chars=MAX_ASSET_ID_CHARS,
                )
                raise SceneAssetError(
                    f"Explicit frozen-field asset '{asset_id}' at {_pointer(reference_parts)} has no file-backed registry in SceneDocument; asset semantics are unsupported"
                )
            if reference_kind not in {"capture_current_at_activation", "initial_state"}:
                raise SceneAssetError(f"Unsupported frozen-spin reference kind '{reference_kind}' at {_pointer(reference_parts)}")

    return references


def collect_scene_assets(scene: dict[str, Any]) -> list[dict[str, str]]:
    """Return each file source declared by the current typed SceneDocument.

    ``asset_id`` is the RFC 6901 JSON Pointer to the exact source string. The
    function never searches arbitrary JSON strings or opaque ``path`` keys.
    Unsupported asset-id references and unknown geometry/preset semantics raise
    :class:`SceneAssetError` so callers cannot report a complete handoff.
    """
    return [
        {"asset_id": reference.asset_id, "source_path": reference.source_path}
        for reference in _collect_references(scene)
    ]


def _verified_asset_map(verified_assets: Any) -> dict[str, str]:
    if not isinstance(verified_assets, (list, tuple)) or len(verified_assets) > MAX_SCENE_ASSETS:
        raise SceneAssetError(f"verified_assets must be a list of at most {MAX_SCENE_ASSETS} entries")
    result: dict[str, str] = {}
    expected_keys = {"asset_id", "sha256", "size_bytes", "storage_path"}
    for index, value in enumerate(verified_assets):
        entry = _object(value, f"/verified_assets/{index}", "verified asset")
        if set(entry) != expected_keys:
            raise SceneAssetError(f"verified_assets[{index}] has an unexpected shape")
        asset_id = _required_string(entry["asset_id"], f"/verified_assets/{index}/asset_id", "Verified asset id", max_chars=MAX_ASSET_ID_CHARS)
        if asset_id in result:
            raise SceneAssetError(f"Duplicate verified asset id '{asset_id}'")
        digest = entry["sha256"]
        if not isinstance(digest, str) or not _SHA256.fullmatch(digest):
            raise SceneAssetError(f"verified_assets[{index}].sha256 is invalid")
        size_bytes = entry["size_bytes"]
        if isinstance(size_bytes, bool) or not isinstance(size_bytes, int) or size_bytes <= 0:
            raise SceneAssetError(f"verified_assets[{index}].size_bytes is invalid")
        storage_path = _required_string(
            entry["storage_path"],
            f"/verified_assets/{index}/storage_path",
            "Verified capsule storage_path",
            max_chars=MAX_SOURCE_PATH_CHARS,
        )
        result[asset_id] = storage_path
    return result


def _set_pointer(root: dict[str, Any], parts: tuple[str | int, ...], value: str) -> None:
    if not parts:
        raise SceneAssetError("Asset source pointer cannot target the scene root")
    current: Any = root
    for segment in parts[:-1]:
        if isinstance(current, list):
            if not isinstance(segment, int) or segment < 0 or segment >= len(current):
                raise SceneAssetError(f"Asset pointer no longer resolves in copied scene: {_pointer(parts)}")
            current = current[segment]
        elif isinstance(current, dict):
            if not isinstance(segment, str) or segment not in current:
                raise SceneAssetError(f"Asset pointer no longer resolves in copied scene: {_pointer(parts)}")
            current = current[segment]
        else:
            raise SceneAssetError(f"Asset pointer no longer resolves in copied scene: {_pointer(parts)}")
    final = parts[-1]
    if isinstance(current, list):
        if not isinstance(final, int) or final < 0 or final >= len(current):
            raise SceneAssetError(f"Asset pointer no longer resolves in copied scene: {_pointer(parts)}")
        current[final] = value
    elif isinstance(current, dict):
        if not isinstance(final, str) or final not in current:
            raise SceneAssetError(f"Asset pointer no longer resolves in copied scene: {_pointer(parts)}")
        current[final] = value
    else:
        raise SceneAssetError(f"Asset pointer no longer resolves in copied scene: {_pointer(parts)}")


def _rebase_declared_scene_assets(scene: dict[str, Any], verified_assets: Any) -> dict[str, Any]:
    """Structurally rewrite declared paths using a previously verified manifest.

    This pure rewrite is not a filesystem-verification API. The capsule loader
    must already have verified the manifest and file bytes. The manifest must
    match the scene reference set exactly. The input scene is never modified,
    and all other authored fields are preserved.
    """
    references = _collect_references(scene)
    verified = _verified_asset_map(verified_assets)
    expected = {reference.asset_id for reference in references}
    supplied = set(verified)
    missing = sorted(expected - supplied)
    extra = sorted(supplied - expected)
    if missing or extra:
        details = []
        if missing:
            details.append(f"missing verified assets: {', '.join(missing[:4])}")
        if extra:
            details.append(f"unreferenced verified assets: {', '.join(extra[:4])}")
        raise SceneAssetError("Verified handoff asset manifest does not match SceneDocument (" + "; ".join(details) + ")")

    rebased = copy.deepcopy(scene)
    for reference in references:
        _set_pointer(rebased, reference.pointer_parts, verified[reference.asset_id])
    return rebased


__all__ = ["SceneAssetError", "collect_scene_assets", "_rebase_declared_scene_assets"]
