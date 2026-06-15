from __future__ import annotations

from typing import Any


def _material_id(name: str) -> str:
    return f"mat:{name}"


def _magnetization_id(name: str) -> str:
    return f"mag:{name}"


def _zero_vec3() -> list[float]:
    return [0.0, 0.0, 0.0]


def _one_vec3() -> list[float]:
    return [1.0, 1.0, 1.0]


def _identity_quat() -> list[float]:
    return [0.0, 0.0, 0.0, 1.0]


def _default_mapping() -> dict[str, object]:
    return {
        "space": "object",
        "projection": "object_local",
        "clamp_mode": "none",
    }


def _default_texture_transform() -> dict[str, object]:
    return {
        "translation": _zero_vec3(),
        "rotation_quat": _identity_quat(),
        "scale": _one_vec3(),
        "pivot": _zero_vec3(),
    }


_INTERACTION_ORDER = (
    "exchange",
    "demag",
    "interfacial_dmi",
    "bulk_dmi",
    "uniaxial_anisotropy",
)


def _normalize_axis3(value: object) -> list[float]:
    if isinstance(value, list) and len(value) == 3:
        try:
            return [float(value[0]), float(value[1]), float(value[2])]
        except (TypeError, ValueError):
            return [0.0, 0.0, 1.0]
    return [0.0, 0.0, 1.0]


def _default_interaction_params(
    kind: str,
    *,
    material_dind: object,
    material_dbulk: object,
) -> dict[str, object] | None:
    if kind == "interfacial_dmi":
        dind = _number_or_none(material_dind)
        return {"dind": dind if dind is not None else 1e-3}
    if kind == "bulk_dmi":
        dbulk = _number_or_none(material_dbulk)
        return {"dbulk": dbulk if dbulk is not None else 1e-3}
    if kind == "uniaxial_anisotropy":
        return {"ku1": 0.0, "axis": [0.0, 0.0, 1.0]}
    return None


def _normalize_interaction_entry(
    raw: object,
    *,
    material_dind: object,
    material_dbulk: object,
) -> dict[str, object] | None:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()
    if kind not in _INTERACTION_ORDER:
        return None
    if kind in {"exchange", "demag"}:
        return {"kind": kind, "enabled": bool(raw.get("enabled", True)), "params": None}
    params = raw.get("params")
    params_map = dict(params) if isinstance(params, dict) else (
        _default_interaction_params(
            kind,
            material_dind=material_dind,
            material_dbulk=material_dbulk,
        ) or {}
    )
    if kind == "interfacial_dmi":
        dind = _number_or_none(params_map.get("dind"))
        if dind is None:
            dind = _number_or_none(material_dind)
        params_map["dind"] = dind if dind is not None else 1e-3
    elif kind == "bulk_dmi":
        dbulk = _number_or_none(params_map.get("dbulk"))
        if dbulk is None:
            dbulk = _number_or_none(material_dbulk)
        params_map["dbulk"] = dbulk if dbulk is not None else 1e-3
    elif kind == "uniaxial_anisotropy":
        ku1 = _number_or_none(params_map.get("ku1"))
        params_map["ku1"] = ku1 if ku1 is not None else 0.0
        params_map["axis"] = _normalize_axis3(params_map.get("axis"))
    return {
        "kind": kind,
        "enabled": bool(raw.get("enabled", True)),
        "params": params_map,
    }


def _ensure_physics_stack(
    raw: object,
    *,
    material_dind: object = None,
    material_dbulk: object = None,
) -> list[dict[str, object]]:
    by_kind: dict[str, dict[str, object]] = {}
    if isinstance(raw, list):
        for entry in raw:
            normalized = _normalize_interaction_entry(
                entry,
                material_dind=material_dind,
                material_dbulk=material_dbulk,
            )
            if normalized is not None:
                by_kind[str(normalized["kind"])] = normalized
    for required in ("exchange", "demag"):
        if required not in by_kind:
            by_kind[required] = {"kind": required, "enabled": True, "params": None}
    if material_dind is not None and "interfacial_dmi" not in by_kind:
        by_kind["interfacial_dmi"] = _normalize_interaction_entry(
            {"kind": "interfacial_dmi", "enabled": True, "params": None},
            material_dind=material_dind,
            material_dbulk=None,
        ) or {"kind": "interfacial_dmi", "enabled": True, "params": {"dind": 1e-3}}
    if material_dbulk is not None and "bulk_dmi" not in by_kind:
        by_kind["bulk_dmi"] = _normalize_interaction_entry(
            {"kind": "bulk_dmi", "enabled": True, "params": None},
            material_dind=None,
            material_dbulk=material_dbulk,
        ) or {"kind": "bulk_dmi", "enabled": True, "params": {"dbulk": 1e-3}}
    ordered: list[dict[str, object]] = []
    for kind in _INTERACTION_ORDER:
        entry = by_kind.get(kind)
        if entry is not None:
            ordered.append(entry)
    return ordered


def build_scene_document_from_builder(builder: dict[str, Any]) -> dict[str, Any]:
    geometries = builder.get("geometries") or []
    objects: list[dict[str, Any]] = []
    materials: list[dict[str, Any]] = []
    magnetization_assets: list[dict[str, Any]] = []

    for geometry in geometries:
        name = str(geometry.get("name", "object"))
        geometry_params = dict(geometry.get("geometry_params") or {})
        translation = geometry_params.pop("translation", geometry_params.pop("translate", [0, 0, 0]))
        role = str(geometry.get("role") or "magnet")
        is_auxiliary = role != "magnet"
        magnetization = dict(geometry.get("magnetization") or {})
        mag_kind = str(magnetization.get("kind", "uniform"))
        if mag_kind == "file" and (
            magnetization.get("dataset") is not None or magnetization.get("sample_index") is not None
        ):
            mag_kind = "sampled"

        material_properties = dict(geometry.get("material") or {})
        object_regions = list(geometry.get("object_regions") or [])
        allocated_region_ids = list(geometry.get("allocated_region_ids") or [])
        for region in object_regions:
            if isinstance(region, dict):
                region_id = region.get("region_id") or region.get("id")
                if isinstance(region_id, str) and region_id not in allocated_region_ids:
                    allocated_region_ids.append(region_id)
        physics_stack = _ensure_physics_stack(
            geometry.get("physics_stack"),
            material_dind=material_properties.get("Dind"),
            material_dbulk=material_properties.get("Dbulk"),
        )

        objects.append(
            {
                "id": name,
                "name": name,
                "role": role,
                "geometry": {
                    "geometry_kind": str(geometry.get("geometry_kind", "")),
                    "geometry_params": geometry_params,
                    "bounds_min": geometry.get("bounds_min"),
                    "bounds_max": geometry.get("bounds_max"),
                },
                "transform": {
                    "translation": translation if isinstance(translation, list) else [0, 0, 0],
                    "rotation_quat": _identity_quat(),
                    "scale": _one_vec3(),
                    "pivot": _zero_vec3(),
                },
                "material_ref": "" if is_auxiliary else _material_id(name),
                "region_name": geometry.get("region_name"),
                "magnetization_ref": None if is_auxiliary else _magnetization_id(name),
                "physics_stack": [] if is_auxiliary else physics_stack,
                "object_mesh": geometry.get("mesh"),
                "mesh_override": geometry.get("mesh"),
                "regions": object_regions,
                "allocated_region_ids": allocated_region_ids,
                "material_parameter_fields": geometry.get("material_parameter_fields") or [],
                "visualization_hint": geometry.get("visualization_hint") or {},
                "visible": True,
                "locked": False,
                "tags": [f"role:{role}"] if is_auxiliary else [],
            }
        )
        if is_auxiliary:
            continue
        materials.append(
            {
                "id": _material_id(name),
                "name": f"{name} material",
                "properties": material_properties,
            }
        )
        magnetization_assets.append(
            {
                "id": _magnetization_id(name),
                "name": f"{name} magnetization",
                "kind": mag_kind,
                "value": magnetization.get("value"),
                "seed": magnetization.get("seed"),
                "source_path": magnetization.get("source_path"),
                "source_format": magnetization.get("source_format"),
                "dataset": magnetization.get("dataset"),
                "sample_index": magnetization.get("sample_index"),
                "mapping": dict(magnetization.get("mapping") or _default_mapping()),
                "texture_transform": dict(
                    magnetization.get("texture_transform") or _default_texture_transform()
                ),
                "preset_kind": magnetization.get("preset_kind"),
                "preset_params": magnetization.get("preset_params"),
                "preset_version": magnetization.get("preset_version"),
                "ui_label": magnetization.get("ui_label"),
            }
        )

    return {
        "version": "scene.v2",
        "revision": int(builder.get("revision", 0)),
        "scene": {
            "id": "scene",
            "name": "Scene",
            "source_of_truth": "repo_head",
            "authoring_schema": "mesh-first-fem.v1",
        },
        "universe": builder.get("universe"),
        "objects": objects,
        "materials": materials,
        "magnetization_assets": magnetization_assets,
        "current_modules": {
            "modules": builder.get("current_modules") or [],
            "excitation_analysis": builder.get("excitation_analysis"),
        },
        "couplings": builder.get("couplings") or [],
        "study": {
            "backend": builder.get("backend"),
            "requested_backend": "auto",
            "requested_device": "auto",
            "requested_precision": "double",
            "requested_mode": "strict",
            "requested_cpu_threads": builder.get("cpu_threads"),
            "fem_demag_solver_policy": builder.get("fem_demag_solver_policy"),
            "exchange_enabled": bool(builder.get("exchange_enabled", True)),
            "demag_enabled": bool(builder.get("demag_enabled", True)),
            "demag_realization": builder.get("demag_realization"),
            "external_field": builder.get("external_field"),
            "solver": builder.get("solver") or {},
            "universe_mesh": builder.get("universe"),
            "shared_domain_mesh": builder.get("mesh") or {},
            "mesh_defaults": builder.get("mesh") or {},
            "stages": builder.get("stages") or [],
            "study_pipeline": builder.get("study_pipeline"),
            "table_autosave": builder.get("table_autosave"),
            "initial_state": builder.get("initial_state"),
        },
        "outputs": {"items": []},
        "editor": {
            "selected_object_id": None,
            "gizmo_mode": None,
            "transform_space": None,
            "selected_entity_id": None,
            "focused_entity_id": None,
            "object_view_mode": "context",
            "air_mesh_visible": True,
            "air_mesh_opacity": 28.0,
            "mesh_entity_view_state": {},
            "active_transform_scope": None,
        },
    }


def build_builder_from_scene_document(scene: dict[str, Any]) -> dict[str, Any]:
    materials = {
        str(material.get("id", "")): dict(material.get("properties") or {})
        for material in (scene.get("materials") or [])
    }
    magnetization_assets = {
        str(asset.get("id", "")): dict(asset)
        for asset in (scene.get("magnetization_assets") or [])
    }
    geometries: list[dict[str, Any]] = []

    for obj in scene.get("objects") or []:
        role = str(obj.get("role") or "magnet")
        is_auxiliary = role != "magnet"
        material_ref = str(obj.get("material_ref") or "")
        if not is_auxiliary and (not material_ref or material_ref not in materials):
            raise ValueError(
                f"object '{obj.get('id') or obj.get('name') or ''}' references missing material '{material_ref}'"
            )
        magnetization_ref = str(obj.get("magnetization_ref") or "")
        if not is_auxiliary and (
            not magnetization_ref or magnetization_ref not in magnetization_assets
        ):
            raise ValueError(
                f"object '{obj.get('id') or obj.get('name') or ''}' references missing magnetization asset '{magnetization_ref}'"
            )
        geometry = dict(obj.get("geometry") or {})
        geometry_params = dict(geometry.get("geometry_params") or {})
        transform = dict(obj.get("transform") or {})
        translation = transform.get("translation")
        if isinstance(translation, list) and len(translation) == 3:
            if any(abs(float(value)) > 0 for value in translation):
                geometry_params["translation"] = [float(value) for value in translation]

        magnetization_asset = magnetization_assets.get(magnetization_ref, {})
        magnetization = {
            "kind": str(magnetization_asset.get("kind", "uniform")),
            "value": magnetization_asset.get("value"),
            "seed": magnetization_asset.get("seed"),
            "source_path": magnetization_asset.get("source_path"),
            "source_format": magnetization_asset.get("source_format"),
            "dataset": magnetization_asset.get("dataset"),
            "sample_index": magnetization_asset.get("sample_index"),
            "mapping": dict(magnetization_asset.get("mapping") or _default_mapping()),
            "texture_transform": dict(
                magnetization_asset.get("texture_transform") or _default_texture_transform()
            ),
            "preset_kind": magnetization_asset.get("preset_kind"),
            "preset_params": magnetization_asset.get("preset_params"),
            "preset_version": magnetization_asset.get("preset_version"),
            "ui_label": magnetization_asset.get("ui_label"),
        }
        material_properties = materials.get(material_ref, {})
        physics_stack = _ensure_physics_stack(
            obj.get("physics_stack"),
            material_dind=material_properties.get("Dind"),
            material_dbulk=material_properties.get("Dbulk"),
        )

        entry: dict[str, Any] = {
            "name": str(obj.get("name") or obj.get("id") or ""),
            "role": role,
            "region_name": obj.get("region_name"),
            "geometry_kind": str(geometry.get("geometry_kind", "")),
            "geometry_params": geometry_params,
            "bounds_min": geometry.get("bounds_min"),
            "bounds_max": geometry.get("bounds_max"),
            "mesh": obj.get("object_mesh", obj.get("mesh_override")),
            "object_regions": obj.get("regions") or [],
            "allocated_region_ids": obj.get("allocated_region_ids") or [],
            "material_parameter_fields": obj.get("material_parameter_fields") or [],
            "visualization_hint": obj.get("visualization_hint") or {},
        }
        if not is_auxiliary:
            entry["material"] = material_properties
            entry["magnetization"] = magnetization
            entry["physics_stack"] = physics_stack
        geometries.append(entry)

    study = dict(scene.get("study") or {})
    current_modules = dict(scene.get("current_modules") or {})
    return {
        "revision": int(scene.get("revision", 0)),
        "backend": study.get("backend"),
        "cpu_threads": study.get("requested_cpu_threads"),
        "fem_demag_solver_policy": study.get("fem_demag_solver_policy"),
        "exchange_enabled": bool(study.get("exchange_enabled", True)),
        "demag_enabled": bool(study.get("demag_enabled", True)),
        "demag_realization": study.get("demag_realization"),
        "external_field": study.get("external_field"),
        "solver": study.get("solver") or {},
        "mesh": study.get("shared_domain_mesh") or study.get("mesh_defaults") or {},
        "universe": study.get("universe_mesh") or scene.get("universe"),
        "stages": study.get("stages") or [],
        "study_pipeline": study.get("study_pipeline"),
        "table_autosave": study.get("table_autosave"),
        "initial_state": study.get("initial_state"),
        "geometries": geometries,
        "couplings": scene.get("couplings") or [],
        "current_modules": current_modules.get("modules") or [],
        "excitation_analysis": current_modules.get("excitation_analysis"),
    }


def builder_overrides_from_scene_document(scene: dict[str, Any]) -> dict[str, Any]:
    builder = build_builder_from_scene_document(scene)
    solver = dict(builder.get("solver") or {})
    mesh = dict(builder.get("mesh") or {})
    return {
        "runtime_selection": {
            "cpu_threads": _int_or_none(builder.get("cpu_threads")),
        },
        "fem_demag_solver_policy": (
            dict(builder.get("fem_demag_solver_policy"))
            if isinstance(builder.get("fem_demag_solver_policy"), dict)
            else None
        ),
        "exchange_enabled": bool(builder.get("exchange_enabled", True)),
        "demag_enabled": bool(builder.get("demag_enabled", True)),
        "demag_realization": builder.get("demag_realization"),
        "external_field": (
            [float(value) for value in builder.get("external_field")]
            if isinstance(builder.get("external_field"), list)
            and len(builder.get("external_field")) == 3
            else None
        ),
        "solver": {
            "integrator": solver.get("integrator") or None,
            "fixed_timestep": _number_or_none(solver.get("fixed_timestep")),
            "relax": {
                "algorithm": solver.get("relax_algorithm") or None,
                "torque_tolerance": _number_or_none(solver.get("torque_tolerance")),
                "energy_tolerance": _number_or_none(solver.get("energy_tolerance")),
                "max_steps": _int_or_none(solver.get("max_relax_steps")),
            },
        },
        "mesh": {
            "algorithm_2d": mesh.get("algorithm_2d"),
            "algorithm_3d": mesh.get("algorithm_3d"),
            "hmax": _number_or_auto(mesh.get("maximum_element_size") or mesh.get("hmax")),
            "hmin": _number_or_none(mesh.get("minimum_element_size") or mesh.get("hmin")),
            "maximum_element_size": _number_or_auto(mesh.get("maximum_element_size") or mesh.get("hmax")),
            "minimum_element_size": _number_or_none(mesh.get("minimum_element_size") or mesh.get("hmin")),
            "calibrate_for": mesh.get("calibrate_for") or None,
            "size_preset": mesh.get("size_preset") or None,
            "size_factor": mesh.get("size_factor"),
            "size_from_curvature": mesh.get("size_from_curvature"),
            "curvature_factor": _number_or_none(mesh.get("curvature_factor")),
            "growth_rate": _number_or_none(
                mesh.get("maximum_element_growth_rate") or mesh.get("growth_rate")
            ),
            "maximum_element_growth_rate": _number_or_none(
                mesh.get("maximum_element_growth_rate") or mesh.get("growth_rate")
            ),
            "narrow_regions": mesh.get("narrow_regions"),
            "narrow_region_resolution": _number_or_none(mesh.get("narrow_region_resolution")),
            "resolved_size_from_curvature": _int_or_none(mesh.get("resolved_size_from_curvature")),
            "resolved_narrow_regions": _int_or_none(mesh.get("resolved_narrow_regions")),
            "resolved_growth_rate": _number_or_none(mesh.get("resolved_growth_rate")),
            "smoothing_steps": mesh.get("smoothing_steps"),
            "optimize": mesh.get("optimize") or None,
            "optimize_iterations": mesh.get("optimize_iterations"),
            "compute_quality": mesh.get("compute_quality"),
            "per_element_quality": mesh.get("per_element_quality"),
            "adaptive_mesh": None
            if not mesh.get("adaptive_enabled")
            else {
                "enabled": True,
                "policy": mesh.get("adaptive_policy"),
                "indicator": mesh.get("adaptive_indicator"),
                "target_quantity": mesh.get("adaptive_target_quantity"),
                "convergence_metric": mesh.get("adaptive_convergence_metric"),
                "theta": mesh.get("adaptive_theta"),
                "h_min": _number_or_none(mesh.get("adaptive_h_min")),
                "h_max": _number_or_none(mesh.get("adaptive_h_max")),
                "max_passes": mesh.get("adaptive_max_passes"),
                "error_tolerance": _number_or_none(mesh.get("adaptive_error_tolerance")),
            },
        },
        "universe": builder.get("universe"),
        "stages": [
            {
                "kind": stage.get("kind"),
                "entrypoint_kind": stage.get("entrypoint_kind"),
                "integrator": stage.get("integrator") or None,
                "fixed_timestep": _number_or_none(stage.get("fixed_timestep")),
                "until_seconds": _number_or_none(stage.get("until_seconds")),
                "relax_algorithm": stage.get("relax_algorithm") or None,
                "torque_tolerance": _number_or_none(stage.get("torque_tolerance")),
                "energy_tolerance": _number_or_none(stage.get("energy_tolerance")),
                "max_steps": _int_or_none(stage.get("max_steps")),
                "eigen_count": _int_or_none(stage.get("eigen_count")),
                "eigen_target": stage.get("eigen_target") or None,
                "eigen_include_demag": (
                    bool(stage.get("eigen_include_demag"))
                    if isinstance(stage.get("eigen_include_demag"), bool)
                    else None
                ),
                "eigen_equilibrium_source": stage.get("eigen_equilibrium_source") or None,
                "eigen_normalization": stage.get("eigen_normalization") or None,
                "eigen_target_frequency": _number_or_none(stage.get("eigen_target_frequency")),
                "eigen_frequency_min": _number_or_none(stage.get("eigen_frequency_min")),
                "eigen_frequency_max": _number_or_none(stage.get("eigen_frequency_max")),
                "eigen_damping_policy": stage.get("eigen_damping_policy") or None,
                "eigen_k_vector": stage.get("eigen_k_vector") or None,
                "eigen_spin_wave_bc": stage.get("eigen_spin_wave_bc") or None,
                "eigen_spin_wave_bc_config": (
                    dict(stage.get("eigen_spin_wave_bc_config"))
                    if isinstance(stage.get("eigen_spin_wave_bc_config"), dict)
                    else None
                ),
            }
            for stage in (builder.get("stages") or [])
        ],
        "study_pipeline": builder.get("study_pipeline"),
        "table_autosave": builder.get("table_autosave"),
        "initial_state": builder.get("initial_state"),
        "geometries": builder.get("geometries") or [],
        "couplings": builder.get("couplings") or [],
        "current_modules": builder.get("current_modules") or [],
        "excitation_analysis": builder.get("excitation_analysis"),
    }


def _number_or_none(value: Any) -> float | str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        if stripped.lower() == "auto":
            return "auto"
        try:
            return float(stripped)
        except ValueError:
            return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _number_or_auto(value: Any) -> float | str | None:
    return _number_or_none(value)


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return int(stripped)
        except ValueError:
            return None
    if isinstance(value, (int, float)):
        return int(value)
    return None
